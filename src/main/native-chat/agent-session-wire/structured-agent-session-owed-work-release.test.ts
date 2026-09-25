// Switching away from a chat starts the release clock, and the clock must never stop a provider
// child that still owes the user work.
//
// A Claude chat is published before its CLI answers initialize, and a message sent in that window
// is held until it does; evicting then refuses a message the user already sent. And a lead whose
// turn has settled can leave subagents, commands and monitors running inside the child; evicting
// then ends them silently.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const SURFACE = 'desktop-chat:1'
const GRACE_MS = 5

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let claude: ReturnType<typeof fakeClaude>
let landInit: () => void
let lifecycle: Promise<void>[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-owed-work-release-'))
  resetHostTestOperationIds()
  claude = fakeClaude()
  lifecycle = []
  const initLanded = new Promise<void>((resolve) => {
    landInit = resolve
  })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    // As the runtime wires it: a held prompt's outcome reaches the journal out of band.
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    // Initialize answers only when the test says so.
    openConnection: async (launch, handlers) => {
      const connection = await claude.openConnection(launch, handlers)
      const answer = connection.initializationResult
      connection.initializationResult = async () => {
        await initLanded
        return answer()
      }
      return connection
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    releaseGraceMs: GRACE_MS,
    now: () => NOW
  })
})

afterEach(async () => {
  vi.useRealTimers()
  landInit()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

async function attachStarting(): Promise<void> {
  const created = await host.attach(
    CALLER,
    hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
    })
  )
  expect(created).toMatchObject({ ok: true })
  await host.hold(SESSION, SURFACE)
}

async function send(text: string, dispatchState = 'pending'): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState } } })
  return sent.ok ? sent.value.clientMessageId : ''
}

function dispatchState(clientMessageId: string): string | undefined {
  return host
    .journalSnapshot(SESSION)
    .submissions.find((entry) => entry.clientMessageId === clientMessageId)?.dispatchState
}

/** Long enough for several grace windows to elapse, so "not evicted" means the clock declined. */
function waitOutSeveralGraceWindows(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))
}

describe('a chat left while its Claude CLI is still starting', () => {
  it('keeps the session for a message it is holding, and delivers it once startup lands', async () => {
    await attachStarting()
    const held = await send('sent while starting')

    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()

    expect(host.hasSession(SESSION)).toBe(true)
    expect(claude.connections[0].closeCount).toBe(0)
    expect(dispatchState(held)).toBe('pending')

    landInit()
    await adapter.drainStartup(SESSION)

    expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })])
    await vi.waitFor(() => expect(dispatchState(held)).toBe('accepted'))
  })

  it('gives the message it wrote at startup a full grace to open its turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await attachStarting()
    const held = await send('sent while starting')
    const connection = claude.connections[0]
    // Claude echoes a prompt only when it starts that turn, which a loaded machine delays.
    connection.send = async (message) => {
      connection.sent.push(message)
    }
    host.release(SESSION, SURFACE)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3 - 1)
    expect(host.hasSession(SESSION)).toBe(true)

    // Startup lands just before the clock's next tick.
    landInit()
    await adapter.drainStartup(SESSION)
    await Promise.all(lifecycle)
    expect(connection.sent).toEqual([expect.objectContaining({ type: 'user' })])
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1)

    expect(host.hasSession(SESSION)).toBe(true)
    expect(connection.closeCount).toBe(0)
    connection.handlers.onMessage?.(connection.sent[0])
    await host.flushStreamedEvents(SESSION)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3)
    expect(host.hasSession(SESSION)).toBe(true)
    expect(dispatchState(held)).toBe('accepted')
  })

  it('is released after the grace once its turn has finished', async () => {
    await attachStarting()
    landInit()
    await adapter.drainStartup(SESSION)
    await send('answered', 'accepted')
    claude.connections[0].handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: PROVIDER_SESSION_ID,
      is_error: false,
      result: 'done'
    })
    await host.flushStreamedEvents(SESSION)
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(1)

    host.release(SESSION, SURFACE)

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('is released after the grace when it owes nothing', async () => {
    await attachStarting()

    host.release(SESSION, SURFACE)

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(claude.connections[0].closeCount).toBe(1)
  })
})

describe('a chat left while its settled lead still has background work running', () => {
  function frame(message: Record<string, unknown>): void {
    claude.connections[0].handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  }

  async function settleTurnLeavingTask(taskType: string): Promise<void> {
    await attachStarting()
    landInit()
    await adapter.drainStartup(SESSION)
    await send('fan out', 'accepted')
    frame({
      type: 'system',
      subtype: 'task_started',
      uuid: 'task-start-1',
      task_id: 'task-1',
      task_type: taskType,
      is_backgrounded: true
    })
    frame({ type: 'result', subtype: 'success', uuid: 'result-1', is_error: false, result: 'ok' })
    await host.flushStreamedEvents(SESSION)
    expect(adapter.backgroundTaskState(SESSION)?.tasks).toEqual([
      expect.objectContaining({ id: 'task-1' })
    ])
  }

  it.each([
    ['a subagent', 'local_agent'],
    ['a background command', 'local_bash'],
    ['a monitor', 'monitor']
  ])('keeps the session while %s runs, then releases it once that settles', async (_, type) => {
    await settleTurnLeavingTask(type)

    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()

    expect(host.hasSession(SESSION)).toBe(true)
    expect(claude.connections[0].closeCount).toBe(0)

    frame({
      type: 'system',
      subtype: 'task_notification',
      uuid: 'task-done-1',
      task_id: 'task-1',
      status: 'completed'
    })
    // A finished background task can wake the lead; that turn is owed too until it settles.
    frame({ type: 'result', subtype: 'success', uuid: 'result-2', is_error: false, result: 'ok' })
    await host.flushStreamedEvents(SESSION)

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
