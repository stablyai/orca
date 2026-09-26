import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  invokeCanUseTool,
  PROVIDER_SESSION_ID,
  tick
} from './claude-structured-session-test-support'

describe('ClaudeStructuredSessionAdapter close and exit recovery', () => {
  it('shares concurrent close finalization and emits lifecycle once', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistence = Promise.withResolvers<void>()
    const persistHandle = vi.fn(() => persistence.promise)
    const adapter = adapterFor(claude, {}, events, [], undefined, persistHandle)
    const journalSink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journalSink
    })
    const session = (
      adapter as unknown as {
        sessions: Map<string, { translator: { dispose: () => void } | null }>
      }
    ).sessions.get('session-1')
    const disposeTranslator = vi.spyOn(session!.translator!, 'dispose')

    const first = adapter.closeSession('session-1')
    const second = adapter.closeSession('session-1')
    await tick()
    expect(persistHandle).toHaveBeenCalledOnce()
    expect(claude.connections[0].closeCount).toBe(1)

    persistence.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(events.filter((event) => event.type === 'handle')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(disposeTranslator).toHaveBeenCalledOnce()
  })

  it('still emits ended and disposes state when handle delivery throws', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const callbackError = new Error('handle delivery failed')
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        pathToClaudeCodeExecutable: 'claude',
        options: {},
        cwd: '/work/repo',
        claudeConfigDir: '/accounts/claude',
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumesTranscript: false,
        continuesChain: false
      }),
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'handle') {
          throw callbackError
        }
      },
      openConnection: claude.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      persistHandle: vi.fn(async () => undefined)
    })
    const journalSink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journalSink
    })
    const session = (
      adapter as unknown as {
        sessions: Map<string, { translator: { dispose: () => void } | null }>
      }
    ).sessions.get('session-1')
    const disposeTranslator = vi.spyOn(session!.translator!, 'dispose')

    await expect(adapter.closeSession('session-1')).rejects.toBe(callbackError)
    expect(events.filter((event) => event.type === 'handle')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(disposeTranslator).toHaveBeenCalledOnce()
  })

  it('retains a closed session until its durable cursor persistence succeeds', async () => {
    const claude = fakeClaude()
    const persistenceError = new Error('store unavailable')
    const persistHandle = vi
      .fn<NonNullable<ClaudeStructuredSessionAdapterDeps['persistHandle']>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined)
    const adapter = adapterFor(claude, {}, [], [], undefined, persistHandle)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    await expect(adapter.closeSession('session-1')).rejects.toBe(persistenceError)
    expect(persistHandle).toHaveBeenCalledTimes(1)
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persistHandle).toHaveBeenCalledTimes(2)
  })

  it('persists the last completed turn message before graceful close', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistedHandles: unknown[] = []
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'assistant-leaf'
    })
    claude.connections[0].handlers.onMessage?.({
      type: 'result',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'result-frame-uuid'
    })
    claude.connections[0].handlers.onMessage?.({
      type: 'stream_event',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'stream-event-frame-uuid'
    })

    await adapter.closeSession('session-1')

    expect(persistedHandles).toEqual([
      {
        sessionId: 'session-1',
        providerSessionId: PROVIDER_SESSION_ID,
        leafUuid: 'assistant-leaf',
        fence: 7
      }
    ])
    expect(events.at(-2)).toEqual({
      type: 'handle',
      sessionId: 'session-1',
      providerSessionId: PROVIDER_SESSION_ID,
      leafUuid: 'assistant-leaf',
      fence: 7
    })
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('persists the last completed turn, not a half-turn prompt, on an unexpected exit', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const frame = (message: Record<string, unknown>) =>
      claude.connections[0].handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
    frame({ type: 'assistant', uuid: 'crash-leaf' })
    frame({ type: 'result', uuid: 'result-frame-uuid' })
    // The next turn's prompt is live, but its turn never completed.
    frame({ type: 'user', uuid: 'half-turn-prompt' })

    claude.connections[0].handlers.onExit?.(
      new Error('claude stream-json exited (code 1): crashed unexpectedly')
    )
    await tick()

    expect(persistedHandles).toContainEqual({
      sessionId: 'session-1',
      providerSessionId: PROVIDER_SESSION_ID,
      leafUuid: 'crash-leaf',
      fence: 7
    })
    expect(events.at(-1)).toMatchObject({
      type: 'ended',
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: expect.any(String)
    })
  })

  it('publishes lifecycle recovery even when crash-cursor persistence fails', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(
      claude,
      {},
      events,
      [],
      undefined,
      vi.fn().mockRejectedValue(new Error('store unavailable'))
    )
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(events.at(-1)).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
  })

  it('runs the child close proof before publishing unexpected-exit recovery', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const close = vi.spyOn(claude.connections[0], 'close').mockResolvedValue(true)

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(close).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
  })

  it('does not publish recovery while an unexpected-exit close proof is false', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistedHandles: unknown[] = []
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) as unknown as (typeof claude.connections)[0]['close']

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(events.filter((event) => event.type === 'ended')).toEqual([])
    expect(persistedHandles).toEqual([])
  })

  it('retains pending prompts while an unexpected-exit proof is unproven', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const answered = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-1', 'tool-1')
    claude.connections[0].close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false) as unknown as (typeof claude.connections)[0]['close']

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(answered.settled()).toBe(false)
    expect(events.filter((event) => event.type === 'ended')).toEqual([])
  })

  it('publishes unexpected recovery exactly once after a retained proof retries successfully', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) as unknown as (typeof claude.connections)[0]['close']

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    await tick()

    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  })

  it('launches the first replacement from the settled retained turn-end cursor', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistedHandles: unknown[] = []
    const journalSink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
    let durableLeafUuid: string | null = null
    const resolveLaunch = vi.fn(async ({ identity }) => {
      if (
        identity.providerHandle.kind !== 'claude' ||
        identity.providerHandle.sessionId !== PROVIDER_SESSION_ID ||
        identity.providerHandle.leafUuid !== durableLeafUuid
      ) {
        throw new Error('claude durable resume identity changed before spawn')
      }
      if (durableLeafUuid === null) {
        return {
          pathToClaudeCodeExecutable: 'claude',
          options: { sessionId: PROVIDER_SESSION_ID },
          cwd: '/work/repo',
          claudeConfigDir: '/accounts/claude',
          providerSessionId: PROVIDER_SESSION_ID,
          resumeLeafUuid: null,
          resumesTranscript: false,
          continuesChain: false
        }
      }
      return {
        pathToClaudeCodeExecutable: 'claude',
        options: { resume: PROVIDER_SESSION_ID },
        cwd: '/work/repo',
        claudeConfigDir: '/accounts/claude',
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: durableLeafUuid,
        resumesTranscript: true,
        continuesChain: true
      }
    })
    const persistHandle = vi.fn<NonNullable<ClaudeStructuredSessionAdapterDeps['persistHandle']>>(
      async (handle) => {
        durableLeafUuid = handle.leafUuid
        persistedHandles.push(handle)
      }
    )
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch,
      openConnection: claude.openConnection,
      onEvent: (event) => events.push(event),
      readProcessStartTime: async () => 1_700_000_000_000,
      now: () => 1_700_000_000_500,
      persistHandle
    })
    const firstAcquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journalSink
    })
    await adapter.drainStartup('session-1')
    const first = claude.connections[0]
    const oldPrompt = invokeCanUseTool(first, 'Bash', 'permission-retained', 'tool-retained')
    const oldSession = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            translator: { dispose: () => void } | null
            prompts: {
              find: (itemId: string) => { prompt: { settle: (value: unknown) => void } } | null
            }
          }
        >
      }
    ).sessions.get('session-1')
    expect(oldSession?.translator).not.toBeNull()
    const disposeTranslator = vi.spyOn(oldSession!.translator!, 'dispose')
    const pendingPrompt = oldSession?.prompts.find('permission-retained')
    expect(pendingPrompt).not.toBeNull()
    const settlePrompt = vi.spyOn(pendingPrompt!.prompt, 'settle')
    first.handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'observed-retained-leaf'
    })
    first.handlers.onMessage?.({ type: 'result', session_id: PROVIDER_SESSION_ID })
    first.close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) as unknown as (typeof first)['close']
    first.handlers.onExit?.(new Error('crashed before replacement'))
    await tick()

    expect(oldPrompt.settled()).toBe(false)
    expect(events.filter((event) => event.type === 'ended')).toEqual([])

    const replacement = await adapter.acquire({
      identity: {
        ...identityFor(),
        providerHandle: {
          kind: 'claude',
          sessionId: PROVIDER_SESSION_ID,
          leafUuid: 'observed-retained-leaf'
        }
      },
      fence: 8,
      spawnToken: 'spawn-10',
      events: journalSink
    })

    expect(disposeTranslator).toHaveBeenCalledOnce()
    expect(settlePrompt).toHaveBeenCalledOnce()
    expect(settlePrompt).toHaveBeenCalledWith(null)
    expect(persistHandle).toHaveBeenCalledOnce()
    expect(persistedHandles).toEqual([
      {
        sessionId: 'session-1',
        providerSessionId: PROVIDER_SESSION_ID,
        leafUuid: 'observed-retained-leaf',
        fence: 7
      }
    ])
    expect(resolveLaunch).toHaveBeenNthCalledWith(2, {
      identity: {
        ...identityFor(),
        providerHandle: {
          kind: 'claude',
          sessionId: PROVIDER_SESSION_ID,
          leafUuid: 'observed-retained-leaf'
        }
      }
    })
    expect(oldPrompt.settled()).toBe(true)
    expect(events.filter((event) => event.type === 'ended')).toEqual([
      {
        type: 'ended',
        sessionId: 'session-1',
        reason: 'crashed before replacement',
        cause: 'unexpected-exit',
        fence: 7,
        acquisitionGeneration: firstAcquisition.acquisitionGeneration,
        observedAt: 1_700_000_000_500
      }
    ])
    expect(replacement.link).toMatchObject({
      handle: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        leafUuid: 'observed-retained-leaf'
      },
      origin: 'resumed',
      mintedAtFence: 8
    })
    expect(claude.connections[1]?.launch.options).toEqual({ resume: PROVIDER_SESSION_ID })
    expect(claude.connections).toHaveLength(2)
  })
})
