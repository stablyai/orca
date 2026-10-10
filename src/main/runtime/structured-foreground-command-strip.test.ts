import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
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

  async function rig(routes: Parameters<typeof fakeCodex>[0] = {}) {
    const codex = fakeCodex({
      ...routes,
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
    const command = (method: string, id: string, turnId = 'turn-1', processId?: string) =>
      notify(method, {
        threadId: THREAD_ID,
        turnId,
        item: {
          type: 'commandExecution',
          id,
          ...(processId ? { processId } : {}),
          command: id === 'pwd' ? 'pwd' : 'git status --short --branch',
          source: 'unifiedExecStartup',
          status: method === 'item/completed' ? 'completed' : 'inProgress'
        }
      })
    return { host, rosters, turn, command, fence: attached.ok ? attached.value.fence : null }
  }

  type StripHost = Awaited<ReturnType<typeof rig>>['host']

  /** The strip's Stop on the `server` command, as a client sends it. */
  function stopFromStrip(host: StripHost, fence: number | null, operation: string) {
    const fields = {
      turnId: 'background-tasks',
      scope: 'background-tasks' as const,
      taskId: 'codex-command:primary:server'
    }
    return host.cancel(
      { callerKey: 'strip-test' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId: `${Date.now()}-${operation.padStart(32, '0')}`,
          expectedRuntimeFence: fence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.cancel',
            sessionId: SESSION,
            fields
          })
        },
        ...fields
      }
    )
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

  it('stops a surviving command from the strip through Codex background terminals', async () => {
    let running = ['4242']
    const { host, rosters, turn, command, fence } = await rig({
      'thread/backgroundTerminals/list': () => ({
        data: running.map((processId) => ({ processId })),
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': (params) => {
        running = running.filter((processId) => processId !== params?.processId)
        return { terminated: true }
      }
    })
    await turn('turn/started', 'turn-1')
    await command('item/started', 'server', 'turn-1', '4242')
    await turn('turn/completed', 'turn-1')
    expect(rosters.at(-1)).toMatchObject({
      supportsTaskStop: true,
      children: [{ providerId: 'codex-command:primary:server', stoppable: true }]
    })

    const stopped = await stopFromStrip(host, fence, '2')
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(running).toEqual([])
    // The killed process's own end is what takes its row off the strip.
    await command('item/completed', 'server', 'turn-1', '4242')
    expect(rosters.at(-1)).toBeNull()
  })

  it('refuses a Stop whose command still runs, and keeps the row stoppable', async () => {
    const { host, rosters, turn, command, fence } = await rig({
      'thread/backgroundTerminals/list': () => ({
        data: [{ processId: '4242' }],
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': () => ({ terminated: false })
    })
    await turn('turn/started', 'turn-1')
    await command('item/started', 'server', 'turn-1', '4242')
    await turn('turn/completed', 'turn-1')

    await expect(stopFromStrip(host, fence, '3')).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(rosters.at(-1)).toMatchObject({
      children: [{ providerId: 'codex-command:primary:server', stoppable: true }]
    })
  })

  it('answers a Stop that lost contact with Codex as unconfirmed, and keeps the row stoppable', async () => {
    const { host, rosters, turn, command, fence } = await rig({
      'thread/backgroundTerminals/list': () => ({
        data: [{ processId: '4242' }],
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': () => {
        throw new Error('codex app-server connection closed')
      }
    })
    await turn('turn/started', 'turn-1')
    await command('item/started', 'server', 'turn-1', '4242')
    await turn('turn/completed', 'turn-1')

    await expect(stopFromStrip(host, fence, '4')).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(rosters.at(-1)).toMatchObject({
      children: [{ providerId: 'codex-command:primary:server', stoppable: true }]
    })
  })
})
