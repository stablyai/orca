import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { reviseAgentSessionClaudeResumePoint } from '../runtime/agent-session-provider-handle-transition'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink,
  tick
} from './claude-structured-session-test-support'

const FENCE = 7

function liveRecord(): AgentSessionRecord {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ runtimeKind: 'native', runtimeFence: FENCE })
  )
  return {
    ...record,
    location: { ...record.location, executionHostId: LOCAL_EXECUTION_HOST_ID },
    providerHandleChain: [
      {
        linkId: 'created-link',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 500,
        handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
      },
      {
        linkId: 'published-link',
        origin: 'resumed',
        mintedAtFence: FENCE,
        observedAt: 1_000,
        handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'resumed-at' }
      }
    ]
  }
}

/** An owner whose durable record is updated the way the runtime adapter updates it. */
async function liveOwner(
  persistResumePoint?: ClaudeStructuredSessionAdapterDeps['persistResumePoint']
) {
  const store = { record: liveRecord() }
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const persistedHandles: unknown[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { resume: PROVIDER_SESSION_ID },
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: 'resumed-at',
      resumesTranscript: true,
      continuesChain: true
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async (handle) => {
      persistedHandles.push(handle)
    },
    persistResumePoint:
      persistResumePoint ??
      (async ({ providerSessionId, leafUuid, fence }) => {
        store.record = reviseAgentSessionClaudeResumePoint({
          record: store.record,
          fence,
          providerSessionId,
          leafUuid,
          now: 2_000
        })
      })
  })
  await adapter.acquire({
    identity: identityFor(),
    fence: FENCE,
    spawnToken: 'spawn-7',
    events: recordingJournalSink()
  })
  const connection = claude.connections[0]!
  const frame = (message: Record<string, unknown>) =>
    connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  const turn = async (userUuid: string, assistantUuid: string) => {
    frame({ type: 'user', uuid: userUuid })
    frame({ type: 'assistant', uuid: assistantUuid })
    frame({ type: 'system', subtype: 'stop_hook_summary', uuid: `${assistantUuid}-hook` })
    frame({ type: 'result', subtype: 'success', uuid: `${assistantUuid}-result` })
    await tick()
  }
  return { adapter, claude, store, events, persistedHandles, frame, turn }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude durable resume point at turn end', () => {
  it('advances after each completed turn without growing the handle chain', async () => {
    const { adapter, store, turn } = await liveOwner()
    try {
      await turn('u1', 'a1')
      expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'a1' })
      await turn('u2', 'a2')
      expect(store.record.providerHandleChain).toHaveLength(2)
      expect(store.record.providerHandleChain.at(-1)).toMatchObject({
        linkId: 'published-link',
        handle: { leafUuid: 'a2' }
      })
    } finally {
      await adapter.closeAll()
    }
  })

  it('keeps the last completed turn after a crash that ran no close or exit', async () => {
    const { store, frame, turn } = await liveOwner()
    await turn('u1', 'a1')
    await turn('u2', 'a2')
    // The next turn starts, then the host dies before its reply or any close path.
    frame({ type: 'user', uuid: 'u3' })
    await tick()
    const head = store.record.providerHandleChain.at(-1)!.handle
    expect(head).toMatchObject({ leafUuid: 'a2' })

    const resolve = createClaudeStructuredLaunchResolver({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only getRecord from its store.
      store: { getRecord: () => store.record } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false })
    })
    const launch = await resolve({
      identity: {
        ...identityFor(store.record.sessionId),
        providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'a2' }
      }
    })
    // Bookkeeping only: Claude continues from the end of its own conversation.
    expect(launch).toMatchObject({ resumeLeafUuid: 'a2', options: { resume: PROVIDER_SESSION_ID } })
    expect(launch.options).not.toHaveProperty('resumeSessionAt')
  })

  it('lands the close cursor after, never under, an in-flight turn-end write', async () => {
    const write = Promise.withResolvers<void>()
    const { adapter, persistedHandles, turn } = await liveOwner(() => write.promise)
    await turn('u1', 'a1')
    const closed = adapter.closeSession('session-1')
    await tick()
    expect(persistedHandles).toEqual([])
    write.resolve()
    await expect(closed).resolves.toBe(true)
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'a1' })])
  })

  it('never fails or holds up a turn when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persist = vi.fn(async () => {
      throw new Error('record write failed')
    })
    const { adapter, events, persistedHandles, turn } = await liveOwner(persist)
    await turn('u1', 'a1')
    await turn('u2', 'a2')
    expect(persist).toHaveBeenCalledTimes(2)
    expect(
      events.filter((event) => event.type === 'message' && event.message.type === 'result')
    ).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(
      '[claude-resume-point] turn-end resume point was not persisted:',
      expect.objectContaining({ leafUuid: 'a2' })
    )
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'a2' })])
  })

  it('retries a failed write at the next turn end even when the leaf has not moved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failing = true
    const persist = vi.fn(async () => {
      if (failing) {
        throw new Error('record write failed')
      }
    })
    const { adapter, frame, turn } = await liveOwner(persist)
    try {
      await turn('u1', 'a1')
      expect(persist).toHaveBeenCalledTimes(1)
      failing = false
      // A turn that ends without a new message, such as an interrupted one, keeps the same leaf.
      frame({ type: 'result', subtype: 'error_during_execution', uuid: 'a1-result-2' })
      await tick()
      expect(persist).toHaveBeenCalledTimes(2)
      expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ leafUuid: 'a1' }))
    } finally {
      await adapter.closeAll()
    }
  })

  it('ignores a result that trails the child exit', async () => {
    const persist = vi.fn(async () => {})
    const { adapter, claude, frame, persistedHandles, turn } = await liveOwner(persist)
    await turn('u1', 'a1')
    expect(persist).toHaveBeenCalledTimes(1)
    claude.connections[0]!.handlers.onExit?.(new Error('claude crashed'))
    frame({ type: 'user', uuid: 'u2' })
    frame({ type: 'assistant', uuid: 'a2' })
    frame({ type: 'result', subtype: 'success', uuid: 'a2-result' })
    await adapter.drainObservedExits()
    await tick()
    // A result with no owner behind it is not a completed turn; the exit keeps the last one.
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'a1' })])
  })
})
