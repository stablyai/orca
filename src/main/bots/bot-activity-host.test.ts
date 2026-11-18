import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { BotRecordedWorker } from '../../shared/bots/bot-activity-model'
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makeTestBot } from './bot.test-fixture'
import { readBotActivity, readSharedBotActivity, type BotActivityHost } from './bot-activity-host'

const bot = makeTestBot({ folderWorkspaceId: 'fw-1', chatSessionId: 'chat-1' })
const chatPaneKey = structuredAgentSessionStatusPaneKey('chat-1')
const SENTINEL = 'SENTINEL-do-not-ship'

function statusRow(
  paneKey: string,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    connectionId: null,
    receivedAt: 10,
    stateStartedAt: 10,
    ...overrides
  }
}

function automation(id: string, workspaceId = 'folder:fw-1'): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Activity reads only the fields set here and must ignore the rest.
  return {
    id,
    name: `Automation ${id}`,
    workspaceId,
    prompt: SENTINEL,
    precheck: { command: SENTINEL, timeoutSeconds: 30 }
  } as Automation
}

function run(
  id: string,
  automationId: string,
  status: AutomationRun['status'],
  overrides: Partial<AutomationRun> = {}
): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Activity reads only identity, status, time and session fields; the bodies must not reach the reply.
  return {
    id,
    automationId,
    status,
    createdAt: 5,
    chatSessionId: `${id}-chat`,
    outputSnapshot: { content: SENTINEL.repeat(20_000) },
    event: { text: SENTINEL },
    ...overrides
  } as AutomationRun
}

function recordedWorker(
  dispatchId: string,
  state: OrchestrationSessionWorker['state'],
  creator: Pick<BotRecordedWorker, 'creatorSessionId' | 'creatorPaneKey'>
): BotRecordedWorker {
  return {
    worker: {
      dispatchId,
      taskId: `task-${dispatchId}`,
      runId: 'run-1',
      title: `Worker ${dispatchId}`,
      agent: 'claude',
      state,
      liveness: state === 'working' ? 'live' : 'exited',
      host: 'local',
      worktreeId: null,
      paneKey: null,
      chatSessionId: null,
      startedAt: 50,
      settledAt: state === 'working' ? null : 60
    },
    ...creator
  }
}

function host(overrides: Partial<BotActivityHost> = {}): BotActivityHost {
  return {
    bots: () => [bot],
    externalConversations: () => [],
    chatTabs: async () => [{ sessionId: 'chat-1', title: 'Home' }],
    statusRows: () => [],
    automations: () => [],
    automationRuns: () => new Map(),
    recordedWorkers: async () => [],
    ...overrides
  }
}

describe('readBotActivity', () => {
  it("credits a worker the bot's chat started to the chat, from the host's status rows", async () => {
    const activity = await readBotActivity(
      host({
        statusRows: () => [
          statusRow('worker-pane', {
            prompt: 'Fix the flaky test',
            orchestration: { taskId: 't1', dispatchId: 'd1', parentPaneKey: chatPaneKey }
          }),
          statusRow('stranger-pane', {
            orchestration: { taskId: 't2', dispatchId: 'd2', parentPaneKey: 'elsewhere' }
          })
        ]
      }),
      bot.id
    )

    expect(activity.workers).toEqual([
      expect.objectContaining({
        dispatchId: 'd1',
        title: 'Fix the flaky test',
        origin: { kind: 'chat' }
      })
    ])
  })

  it("keeps a terminal run's settled workers after its terminal closes", async () => {
    const recordedWorkers = vi.fn(async () => [
      recordedWorker('d-run', 'completed', { creatorSessionId: null, creatorPaneKey: 'run-term' })
    ])
    const activity = await readBotActivity(
      host({
        automations: () => [automation('a1')],
        automationRuns: () =>
          new Map([
            [
              'a1',
              [
                run('r1', 'a1', 'completed', {
                  chatSessionId: undefined,
                  terminalPaneKey: 'run-term'
                })
              ]
            ]
          ]),
        recordedWorkers
      }),
      bot.id
    )

    expect(recordedWorkers).toHaveBeenCalledWith({
      orcaSessionIds: ['chat-1'],
      paneKeys: [chatPaneKey, 'run-term']
    })
    expect(activity.completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'worker:d-run',
          origin: { kind: 'automation', name: 'Automation a1' }
        })
      ])
    )
  })

  it('sends no prompt, output or event text, and stays small with large run output', async () => {
    const activity = await readBotActivity(
      host({
        automations: () => [automation('a1')],
        automationRuns: () =>
          new Map([
            [
              'a1',
              Array.from({ length: 50 }, (_, index) =>
                run(`a1-${index}`, 'a1', index === 0 ? 'dispatched' : 'completed')
              )
            ]
          ])
      }),
      bot.id
    )
    const reply = JSON.stringify(activity)

    expect(reply).not.toContain(SENTINEL)
    expect(reply.length).toBeLessThan(32 * 1024)
  })

  it('keeps the rest of Activity when the automation runs or the worker records cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const activity = await readBotActivity(
      host({
        statusRows: () => [
          statusRow('worker-pane', {
            orchestration: { taskId: 't1', dispatchId: 'd1', parentPaneKey: chatPaneKey }
          })
        ],
        automations: () => [automation('a1')],
        automationRuns: () => {
          throw new Error('unreadable')
        },
        recordedWorkers: () => Promise.reject(new Error('db closed'))
      }),
      bot.id
    )

    expect(activity.workers.map((row) => row.dispatchId)).toEqual(['d1'])
    error.mockRestore()
  })

  it('refuses a bot this host does not have', async () => {
    await expect(readBotActivity(host(), 'missing')).rejects.toThrow('bot_not_found')
  })
})

describe('readSharedBotActivity', () => {
  it('gives callers who arrive mid-build one shared build after it, so a change made meanwhile is seen', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime is only a key here; the host seam supplies every read.
    const runtime = {} as OrcaRuntimeService
    let title = 'Before'
    // Each build sees the title as it stood when that build began.
    let seen = title
    const chatTabs = vi.fn(async () => {
      seen = title
      return [{ sessionId: 'chat-1', title: 'Home' }]
    })
    const seam = host({
      chatTabs,
      statusRows: () => [
        statusRow('worker-pane', {
          prompt: seen,
          orchestration: { taskId: 't1', dispatchId: 'd1', parentPaneKey: chatPaneKey }
        })
      ]
    })

    const first = readSharedBotActivity(runtime, bot.id, seam)
    title = 'After'
    const [second, third] = [
      readSharedBotActivity(runtime, bot.id, seam),
      readSharedBotActivity(runtime, bot.id, seam)
    ]

    expect((await first).workers[0]?.title).toBe('Before')
    expect((await second).workers[0]?.title).toBe('After')
    expect(await third).toBe(await second)
    expect(chatTabs).toHaveBeenCalledTimes(2)

    await readSharedBotActivity(runtime, bot.id, seam)
    expect(chatTabs).toHaveBeenCalledTimes(3)
  })
})

describe('readBotActivity, a workspace handed to the bot', () => {
  it("shows its agent though another coordinator's Dispatch started it, and a paired computer's too", async () => {
    const activity = await readBotActivity(
      host({
        handedWorktreeIds: async () => new Set(['wt-handed']),
        statusRows: () => [
          statusRow('handed:pane', {
            state: 'blocked',
            worktreeId: 'wt-handed',
            orchestration: {
              taskId: 't-old',
              dispatchId: 'd-old',
              parentPaneKey: 'other-bot:pane',
              taskTitle: 'Fix reconnect'
            }
          })
        ],
        pairedHandedAgents: async () => [
          {
            paneKey: 'remote:pane',
            entry: { state: 'blocked', prompt: 'Push?', stateStartedAt: 3 },
            worktreeId: 'wt-remote',
            hostId: 'runtime:env-1'
          }
        ]
      }),
      bot.id
    )
    expect(activity.workers.map((row) => [row.title, row.dot, row.hostId])).toEqual([
      ['Fix reconnect', 'blocked', undefined],
      ['Push?', 'blocked', 'runtime:env-1']
    ])
  })

  it("names a worker by its Task from the runtime's Dispatch, not by its preamble", async () => {
    const activity = await readBotActivity(
      host({
        handedWorktreeIds: async () => new Set(['wt-handed']),
        // Hook rows never carry their Dispatch.
        statusRows: () => [
          statusRow('worker:pane', {
            worktreeId: 'wt-handed',
            prompt: 'You are working inside Orca, a multi-agent IDE.'
          })
        ],
        orchestrationByPaneKey: () => ({
          'worker:pane': {
            taskId: 't-1',
            dispatchId: 'd-1',
            parentPaneKey: 'other-bot:pane',
            taskTitle: 'Fix reconnect'
          }
        })
      }),
      bot.id
    )
    expect(activity.workers.map((row) => row.title)).toEqual(['Fix reconnect'])
  })
})
