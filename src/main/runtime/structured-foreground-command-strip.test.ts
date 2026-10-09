import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { AgentHookServer, _internals } from '../agent-hooks/server'
import { fakeCodex, THREAD_ID } from '../codex/codex-structured-session-adapter-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

describe('foreground commands in the background-task channel', () => {
  let root: string
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    root = await mkdtemp(join(tmpdir(), 'orca-foreground-command-strip-'))
    server = new AgentHookServer()
  })

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    await rm(root, { recursive: true, force: true })
  })

  async function rig() {
    const codex = fakeCodex({
      'model/list': () => ({
        data: [
          {
            model: 'gpt-test',
            displayName: 'GPT Test',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true
          }
        ],
        nextCursor: null
      })
    })
    const host = await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      statusSink: {
        publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
        forget: (subject) => server.dropStructuredStatus(subject),
        publishChildWork: (subject, evidence, provider) =>
          server.ingestStructuredChildWork(subject, evidence, provider),
        readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
      }
    })
    const params = hostTestAttachParams(null, { providerHandle: undefined })
    params.envelope.clientOperationId = `${Date.now()}-${'1'.padStart(32, '0')}`
    const attached = await host.attach({ callerKey: 'strip-test' }, params)
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
    const rosters: (AgentSessionBackgroundTaskState | null)[] = []
    await host.subscribe({
      id: 'strip',
      sessionId: SESSION,
      emit: (event) => {
        if ('backgroundTasks' in event && event.backgroundTasks !== undefined) {
          rosters.push(event.backgroundTasks)
        }
      }
    })
    const settle = async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    const notify = async (method: string, params: Record<string, unknown>) => {
      codex.connections[0]?.handlers.onNotification?.(method, params)
      await settle()
    }
    const turn = (method: string, id: string) =>
      notify(method, { threadId: THREAD_ID, turn: { id, status: 'completed' } })
    const command = (method: string, id: string, turnId = 'turn-1') =>
      notify(method, {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: 'commandExecution',
          id,
          command: id === 'pwd' ? 'pwd' : 'git status --short --branch',
          source: 'unifiedExecStartup',
          status: method === 'item/completed' ? 'completed' : 'inProgress'
        }
      })
    return { host, rosters, turn, command }
  }

  it('never publishes a strip between a quick command starting and completing', async () => {
    const { host, rosters, turn, command } = await rig()
    await turn('turn/started', 'turn-1')
    for (const id of ['pwd', 'status']) {
      await command('item/started', id)
      const page = await host.history({ sessionId: SESSION, direction: 'tail' })
      expect(page.page.items).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({ kind: 'tool-call', callId: id })
        })
      )
      // Observe every publication, including the start frame before the completion arrives.
      expect(rosters.every((roster) => roster === null)).toBe(true)
      expect(page.page.backgroundTasks).toBeNull()
      await command('item/completed', id)
    }
    await turn('turn/completed', 'turn-1')
    expect(rosters.every((roster) => roster === null)).toBe(true)
  })

  it('shows a surviving command after its own turn ends and throughout the next turn', async () => {
    const { rosters, turn, command } = await rig()
    await turn('turn/started', 'turn-1')
    await command('item/started', 'server')
    await turn('turn/completed', 'turn-1')
    expect(rosters.at(-1)?.tasks).toContainEqual(
      expect.objectContaining({ id: 'codex-command:primary:server', kind: 'command' })
    )
    await turn('turn/started', 'turn-2')
    await command('item/started', 'pwd', 'turn-2')
    expect(rosters.at(-1)?.tasks?.map((task) => task.id)).toEqual(['codex-command:primary:server'])
    await command('item/completed', 'pwd', 'turn-2')
    await command('item/completed', 'server')
    expect(rosters.at(-1)).toBeNull()
  })
})
