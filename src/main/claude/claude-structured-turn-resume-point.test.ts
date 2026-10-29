import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createClaudeStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { reviseAgentSessionProviderResumePoint } from '../runtime/agent-session/ownership/agent-session-provider-handle-transition'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  tick
} from './claude-structured-session-test-support'
import { claudeStartupSettled } from './claude-structured-startup-settled-test-support'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const FENCE = 7
const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []

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
        handle: claudeProviderHandle(PROVIDER_SESSION_ID, null)
      },
      {
        linkId: 'published-link',
        origin: 'resumed',
        mintedAtFence: FENCE,
        observedAt: 1_000,
        handle: claudeProviderHandle(PROVIDER_SESSION_ID, 'resumed-at')
      }
    ]
  }
}

async function liveOwner(
  persistResumePoint?: ClaudeStructuredSessionAdapterDeps['persistResumePoint'],
  options: {
    missingTranscript?: boolean
    beforeOpen?: (frame: (message: Record<string, unknown>) => void) => void
    lifecycleLimit?: number
    resumeLeafUuid?: string | null
    resumesTranscript?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-leaf-'))
  const claudeConfigDir = join(root, 'claude-home')
  const projects = join(claudeConfigDir, 'projects', '-work-repo')
  await mkdir(projects, { recursive: true })
  const transcript = join(projects, `${PROVIDER_SESSION_ID}.jsonl`)
  if (!options.missingTranscript) {
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'resumed-at',
        sessionId: PROVIDER_SESSION_ID,
        message: { role: 'assistant', content: [] }
      })}\n`
    )
  }
  const journal = await journals.open({ identity: identityFor(), stateDirectory: root })
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(),
    ...(options.lifecycleLimit === undefined
      ? {}
      : { watermarks: { maxLifecycleQueuedOperations: options.lifecycleLimit } })
  })
  deferred.bind({ journal, fence: FENCE, publish: () => {} })
  const store = { record: liveRecord() }
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const persistedHandles: unknown[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { resume: PROVIDER_SESSION_ID },
      cwd: '/work/repo',
      claudeConfigDir,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: options.resumeLeafUuid === undefined ? 'resumed-at' : options.resumeLeafUuid,
      resumesTranscript: options.resumesTranscript ?? true,
      cliFlag: async () => 'supported' as const,
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
        store.record = reviseAgentSessionProviderResumePoint({
          record: store.record,
          fence,
          handle: claudeProviderHandle(providerSessionId, leafUuid),
          now: 2_000
        })
      })
  })
  await adapter.acquire({
    identity: identityFor(),
    fence: FENCE,
    spawnToken: 'spawn-7',
    events: deferred.sink
  })
  const frame = (message: Record<string, unknown>) =>
    claude.connections.at(-1)!.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  options.beforeOpen?.(frame)
  await claudeStartupSettled(adapter, 'session-1')
  cleanups.push(async () => {
    await adapter.closeAll()
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const turn = async (userUuid: string, assistantUuid: string) => {
    frame({
      type: 'user',
      uuid: userUuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'ask' }
    })
    frame({
      type: 'assistant',
      uuid: assistantUuid,
      parent_tool_use_id: null,
      message: { id: assistantUuid, role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
    })
    frame({ type: 'system', subtype: 'stop_hook_summary', uuid: `${assistantUuid}-hook` })
    frame({ type: 'result', subtype: 'success', uuid: `${assistantUuid}-result` })
    await tick()
  }
  return {
    adapter,
    claude,
    store,
    events,
    persistedHandles,
    frame,
    turn,
    deferred,
    journal,
    transcript
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

describe('Claude durable resume point at turn end', () => {
  it.each([false, true])(
    'allows a first native checkpoint without a loaded leaf (resume=%s)',
    async (resumesTranscript) => {
      const { store, turn } = await liveOwner(undefined, {
        resumeLeafUuid: null,
        resumesTranscript
      })
      await turn('u1', 'a1')
      expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({ resumeCursor: 'a1' })
    }
  )

  it('re-derives missed suffix coverage on the next acquisition before advancing', async () => {
    const { adapter, store, turn, transcript, journal, deferred } = await liveOwner(undefined, {
      missingTranscript: true
    })
    await turn('u1', 'a1')
    await adapter.closeSession('session-1')
    await writeFile(
      transcript,
      [
        {
          type: 'assistant',
          uuid: 'resumed-at',
          sessionId: PROVIDER_SESSION_ID,
          message: { role: 'assistant', content: [] }
        },
        {
          type: 'assistant',
          uuid: 'outside',
          parentUuid: 'resumed-at',
          sessionId: PROVIDER_SESSION_ID,
          message: { role: 'assistant', content: [{ type: 'text', text: 'outside reply' }] }
        }
      ]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join('')
    )
    await adapter.acquire({
      identity: identityFor(),
      fence: FENCE,
      spawnToken: 'spawn-8',
      events: deferred.sink
    })
    await claudeStartupSettled(adapter, 'session-1')
    expect(
      journal
        .snapshot()
        .items.some(
          (item) =>
            item.body.kind === 'message' &&
            item.body.blocks.some(
              (block) => block.type === 'text' && block.text === 'outside reply'
            )
        )
    ).toBe(true)
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({
      resumeCursor: 'resumed-at'
    })
    await turn('u2', 'a2')
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({ resumeCursor: 'a2' })
  })

  it.each([
    { missingTranscript: true },
    {
      beforeOpen: (frame: (message: Record<string, unknown>) => void) =>
        frame({
          type: 'stream_event',
          uuid: 'early',
          event: { type: 'message_start', message: { id: 'early' } }
        })
    }
  ])('retains the loaded leaf after unproved history, including close: %j', async (options) => {
    const { adapter, store, events, persistedHandles, turn } = await liveOwner(undefined, options)
    await turn('u1', 'a1')
    expect(
      events.some((event) => event.type === 'message' && event.message.type === 'result')
    ).toBe(true)
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({
      resumeCursor: 'resumed-at'
    })
    await adapter.closeAll()
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'resumed-at' })])
  })

  it('keeps the leaf after refused finals even when every admitted write succeeds', async () => {
    const { adapter, store, turn, deferred, journal, persistedHandles } = await liveOwner(
      undefined,
      { lifecycleLimit: 1 }
    )
    deferred.unbind()
    await turn('u1', 'a1')
    deferred.bind({ journal, fence: FENCE, publish: () => {} })
    expect(await deferred.drained()).toEqual({ ok: true })
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({
      resumeCursor: 'resumed-at'
    })
    await adapter.closeAll()
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'resumed-at' })])
  })

  it('publishes the result while journal coverage is pending, and retains the leaf on failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { adapter, store, turn, deferred, events, persistedHandles } = await liveOwner()
    const write = Promise.withResolvers<{ ok: false; error: Error }>()
    deferred.sink.written = () => write.promise
    await turn('u1', 'a1')
    expect(
      events.some((event) => event.type === 'message' && event.message.type === 'result')
    ).toBe(true)
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({
      resumeCursor: 'resumed-at'
    })
    write.resolve({ ok: false, error: new Error('journal failed') })
    await tick()
    await adapter.closeAll()
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'resumed-at' })])
  })

  it('advances after each completed turn without growing the handle chain', async () => {
    const { adapter, store, turn } = await liveOwner()
    try {
      await turn('u1', 'a1')
      expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({ resumeCursor: 'a1' })
      await turn('u2', 'a2')
      expect(store.record.providerHandleChain).toHaveLength(2)
      expect(store.record.providerHandleChain.at(-1)).toMatchObject({
        linkId: 'published-link',
        handle: { resumeCursor: 'a2' }
      })
    } finally {
      await adapter.closeAll()
    }
  })

  it('keeps the last completed turn after a crash that ran no close or exit', async () => {
    const { store, frame, turn } = await liveOwner()
    await turn('u1', 'a1')
    await turn('u2', 'a2')
    frame({ type: 'user', uuid: 'u3' })
    await tick()
    const head = store.record.providerHandleChain.at(-1)!.handle
    expect(head).toMatchObject({ resumeCursor: 'a2' })

    const resolve = createClaudeStructuredLaunchResolver({
      resolveLaunchArgs: () => [],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only getRecord from its store.
      store: { getRecord: () => store.record } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ account: 'system' })
    })
    const launch = await resolve({
      identity: {
        ...identityFor(store.record.sessionId),
        providerHandle: claudeProviderHandle(PROVIDER_SESSION_ID, 'a2')
      }
    })
    // Resume the conversation without rewinding to the bookkeeping cursor.
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
      frame({ type: 'result', subtype: 'error_during_execution', uuid: 'a1-result-2' })
      await tick()
      expect(persist).toHaveBeenCalledTimes(2)
      expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ leafUuid: 'a1' }))
    } finally {
      await adapter.closeAll()
    }
  })

  it('keeps completed output drained through the same connection after its root exits', async () => {
    const persist = vi.fn(async () => {})
    const { adapter, claude, frame, persistedHandles, turn } = await liveOwner(persist)
    await turn('u1', 'a1')
    expect(persist).toHaveBeenCalledTimes(1)
    const connection = claude.connections[0]!
    const close = connection.close.bind(connection)
    const drained = Promise.withResolvers<void>()
    connection.close = async () => {
      await drained.promise
      return close()
    }
    connection.handlers.onExit?.(new Error('claude crashed'))
    frame({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'buffered ask' } })
    frame({
      type: 'assistant',
      uuid: 'a2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'buffered answer' }] }
    })
    frame({ type: 'result', subtype: 'success', uuid: 'a2-result' })
    drained.resolve()
    await adapter.drainObservedExits()
    await tick()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persistedHandles).toEqual([expect.objectContaining({ leafUuid: 'a2' })])
  })
})
