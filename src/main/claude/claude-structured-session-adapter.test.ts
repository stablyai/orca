import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPromptAnswerRejectedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV as SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import type { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  acquired,
  adapterFor,
  adapterAtPublishFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  tick,
  USER_MESSAGE,
  type FakeConnection
} from './claude-structured-session-test-support'
import {
  claudeOpened,
  claudeStartupSettled
} from './claude-structured-startup-settled-test-support'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { providerRequestTimeoutOf } from '../provider-process/provider-request-timeout'

describe('ClaudeStructuredSessionAdapter.acquire', () => {
  it('ends a stalled initialize at its 60-second deadline with the timed-out step', async () => {
    vi.useFakeTimers()
    const claude = fakeClaude({ initDelayMs: 60_001 })
    const adapter = adapterFor(claude)
    let result: Promise<unknown> | undefined
    try {
      let settled = false
      result = adapter
        .acquire({ identity: identityFor(), fence: 7, spawnToken: 'deadline' })
        .catch((error: unknown) => {
          settled = true
          return error
        })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(providerRequestTimeoutOf(await result)).toEqual({
        method: 'initialize',
        timeoutMs: 60_000
      })
      expect(claude.connections).toHaveLength(1)
    } finally {
      claude.dispose()
      try {
        await result
        await adapter.closeAll()
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('pins the account and proves init without treating the system-frame uuid as a chain leaf', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, { continuesChain: true, resumesTranscript: false }, events)

    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(claude.connections[0].launch).toMatchObject({
      cwd: '/work/repo',
      env: {
        [SPAWN_TOKEN_ENV]: 'spawn-9',
        CLAUDE_CONFIG_DIR: '/accounts/claude'
      }
    })
    expect(claude.connections[0].calls.slice(0, 2)).toEqual([
      { subtype: 'initialize' },
      { subtype: 'get_settings' }
    ])
    expect(acquisition.process).toEqual({
      hostId: 'host-1',
      pid: 4321,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-9'
    })
    expect((await claudeOpened(adapter, 'session-1')).link).toEqual({
      linkId: `claude-7-${PROVIDER_SESSION_ID}-empty`,
      handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
      origin: 'resumed',
      mintedAtFence: 7,
      observedAt: 1_700_000_000_500
    })
    expect((await claudeOpened(adapter, 'session-1')).newConversation).toBe(true)
    expect(events[0]).toMatchObject({ type: 'message', message: { subtype: 'hook_started' } })
  })

  it('launches a reacquired session with its persisted model and effort, and writes neither', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude, { resumesTranscript: true, continuesChain: true })

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', effort: 'high' }
    })

    expect(claude.connections[0].launch.options).toMatchObject({ model: 'opus', effort: 'high' })
    expect(claude.connections[0].calls.map((call) => call.subtype)).toEqual([
      'initialize',
      'get_settings'
    ])
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'opus', effort: 'high' }
    })
  })

  it('launches a resumed conversation with its saved Fast as a flag setting', async () => {
    const claude = fakeClaude({
      settings: { effective: { fastMode: true, fastModePerSessionOptIn: false } }
    })
    const adapter = adapterFor(claude, { resumesTranscript: true, continuesChain: true })

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', fastMode: 'true' }
    })

    expect(claude.connections[0].launch.options.settings).toEqual({ fastMode: true })
    expect(
      claude.connections[0].calls.filter((call) => call.subtype === 'apply_flag_settings')
    ).toEqual([])
  })

  it('does not carry a saved Fast into a new conversation whose settings opt in per session', async () => {
    const claude = fakeClaude({
      settings: { effective: { fastMode: false, fastModePerSessionOptIn: true } }
    })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', fastMode: 'true' }
    })

    expect(claude.connections[0].launch.options.settings).toBeUndefined()
    expect(
      claude.connections[0].calls.filter((call) => call.subtype === 'apply_flag_settings')
    ).toEqual([])
    expect(events.find((event) => event.type === 'options-reported')).toMatchObject({
      reportedOptions: { fastMode: true }
    })
  })

  it('leaves Fast for message input when the launch does not carry it', async () => {
    const claude = fakeClaude({
      settings: { applied: {}, effective: {}, sources: {} },
      initModels: [{ value: 'opus', displayName: 'Opus', supportsFastMode: true }]
    })
    const adapter = adapterFor(claude)

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', fastMode: 'true' }
    })
    await claudeOpened(adapter, 'session-1')

    expect(claude.connections[0].launch.options.settings).toBeUndefined()
    expect(
      claude.connections[0].calls.filter((call) => call.subtype === 'apply_flag_settings')
    ).toEqual([])
  })

  it('omits an invalid persisted effort at launch and uses the explicit start mode', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    const resolveLaunch = vi.spyOn(adapter['deps'], 'resolveLaunch')
    const options = { effort: 'retired-effort', permissionMode: 'full-access' }
    const start = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9', options }

    await adapter.acquire({ ...start, permissionMode: 'accept-edits' })
    expect(claude.connections[0].launch.options).not.toHaveProperty('effort')
    expect(resolveLaunch.mock.calls[0]?.[0].permissionMode).toBe('accept-edits')
  })

  it('names a launch that could not be resolved on the host, keeping its error (#34795)', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    vi.spyOn(adapter['deps'], 'resolveLaunch').mockRejectedValueOnce(
      new Error('selector_not_found')
    )

    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchPreparationFailed',
      message: 'selector_not_found'
    })
    expect(claude.connections).toHaveLength(0)
  })

  it('recovers a cancellable lifecycle when the replay arrives after dispatch returned', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const settled = vi.fn()
    const adapter = await acquired(claude, {}, events, settled)

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    const sent = claude.connections[0]!.sent[0]!
    claude.connections[0]!.handlers.onMessage?.({
      ...sent,
      uuid: 'late-turn-1'
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message',
        startsTurn: true,
        message: expect.objectContaining({ uuid: 'late-turn-1' })
      })
    )
    expect(settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        uuid: 'late-turn-1'
      }
    })
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'late-turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
  })

  it('opens each queued exact replay with its own request origin', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const connection = claude.connections[0]!
    const dispatch = async (clientMessageId: string, requestedAt: number): Promise<void> => {
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId,
          body: USER_MESSAGE,
          fence: 7,
          requestedAt
        })
      ).resolves.toMatchObject({ state: 'admitted' })
    }
    const echo = (index: number): void => {
      const sent = connection.sent[index]!
      connection.handlers.onMessage?.({
        ...sent,
        uuid: `turn-${index + 1}`,
        user_message_uuid: sent.uuid
      })
    }

    await dispatch('client-a', 100)
    echo(0)
    await dispatch('client-b', 200)
    await dispatch('client-c', 300)
    echo(1)
    echo(2)

    expect(
      events
        .filter((event) => event.type === 'message' && event.startsTurn === true)
        .map((event) => (event.type === 'message' ? event.requestedAt : undefined))
    ).toEqual([100, 200, 300])
  })

  it('quarantines SDK frames without the acquired session identity', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const settled = vi.fn()
    const adapter = await acquired(claude, {}, events, settled)
    const connection = claude.connections[0]!

    connection.handlers.onMessage?.({
      type: 'assistant',
      uuid: 'foreign-leaf',
      session_id: 'foreign-provider-session',
      message: { role: 'assistant', content: [{ type: 'text', text: 'do not admit' }] }
    })
    connection.handlers.onMessage?.({
      type: 'assistant',
      uuid: 'missing-session-leaf',
      message: { role: 'assistant', content: [{ type: 'text', text: 'do not admit' }] }
    })

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(connection.sent).toHaveLength(1)
    connection.handlers.onMessage?.({
      ...connection.sent[0],
      uuid: 'foreign-replay',
      session_id: 'foreign-provider-session'
    })
    await Promise.resolve()
    expect(
      events.flatMap((event) => (event.type === 'message' ? [event.message.subtype] : []))
    ).toEqual(['hook_started', 'hook_response', 'init'])
    expect(settled).not.toHaveBeenCalled()

    connection.handlers.onMessage?.({
      ...connection.sent[0],
      session_id: PROVIDER_SESSION_ID
    })
    expect(settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        uuid: connection.sent[0]!.uuid
      }
    })
  })

  it('forwards configured launch environment while keeping ownership pins authoritative', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude, {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'configured-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        CLAUDE_CONFIG_DIR: '/wrong/account',
        [SPAWN_TOKEN_ENV]: 'wrong-token'
      }
    })

    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    expect(claude.connections[0].launch.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CONFIG_DIR: '/accounts/claude',
      [SPAWN_TOKEN_ENV]: 'spawn-9'
    })
  })

  it('leaves CLAUDE_CONFIG_DIR unset when the account home is the CLI default', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude, { claudeConfigDir: join(homedir(), '.claude'), env: {} })

    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    // Pinning the CLI's own default suppresses the macOS Keychain and breaks claude.ai login.
    expect(claude.connections[0].launch.env).toEqual({ [SPAWN_TOKEN_ENV]: 'spawn-9' })
  })

  it('re-pins the account home when the launch env would send the child elsewhere', async () => {
    const claude = fakeClaude()
    const accountHome = join(homedir(), '.claude')
    const adapter = adapterFor(claude, {
      claudeConfigDir: accountHome,
      env: { CLAUDE_CONFIG_DIR: '/other/account' }
    })

    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    expect(claude.connections[0].launch.env).toEqual({
      CLAUDE_CONFIG_DIR: accountHome,
      [SPAWN_TOKEN_ENV]: 'spawn-9'
    })
  })

  it('accepts SessionStart as pre-turn proof without treating its system uuid as a leaf', async () => {
    const claude = fakeClaude({ initProof: 'session-start', initUuid: 'session-start-uuid' })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect((await claudeOpened(adapter, 'session-1')).link?.handle).toEqual(
      claudeProviderHandle(PROVIDER_SESSION_ID, null)
    )
    expect(events[0]).toMatchObject({
      type: 'message',
      message: { subtype: 'hook_started', hook_name: 'SessionStart:startup' }
    })
  })

  it('records only non-secret effective auth-lane diagnostics', async () => {
    const claude = fakeClaude({
      settings: {
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.test',
          ANTHROPIC_AUTH_TOKEN: 'secret'
        }
      }
    })
    const events: ClaudeStructuredSessionEvent[] = []
    await acquired(claude, {}, events)

    const diagnostic = events.find((event) => event.type === 'auth-diagnostic')
    expect(diagnostic).toEqual({
      type: 'auth-diagnostic',
      sessionId: 'session-1',
      diagnostic: {
        apiKeySourceConfigured: false,
        baseUrlConfigured: true,
        authTokenConfigured: true,
        apiKeyConfigured: false,
        settingSources: ['user', 'project', 'local']
      }
    })
    expect(JSON.stringify(diagnostic)).not.toContain('secret')
    expect(JSON.stringify(diagnostic)).not.toContain('gateway.example.test')
  })

  it('resumes the same provider id and refuses an init proof for another session', async () => {
    const resumedClaude = fakeClaude()
    const resumed = adapterFor(resumedClaude, {
      resumesTranscript: true,
      continuesChain: true,
      resumeLeafUuid: 'leaf-before'
    })
    await resumed.acquire({
      identity: identityFor(),
      fence: 9,
      spawnToken: 'spawn-9'
    })
    expect((await claudeOpened(resumed, 'session-1')).link?.origin).toBe('resumed')
    expect((await claudeOpened(resumed, 'session-1')).link?.handle).toEqual(
      claudeProviderHandle(PROVIDER_SESSION_ID, 'leaf-before')
    )

    const wrongClaude = fakeClaude({ initSessionId: 'different-session' })
    const wrong = adapterAtPublishFor(wrongClaude)
    await wrong.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    await expect(claudeOpened(wrong, 'session-1')).rejects.toThrow('provider session expected')
    await wrong.closeSession('session-1')
    expect(wrongClaude.connections[0].closeCount).toBe(1)
  })

  it('reports the CLI diagnostic when the child exits during open', async () => {
    const claude = fakeClaude({ holdInit: true })
    const adapter = adapterAtPublishFor(claude)
    let opening: Promise<unknown> | undefined
    onTestFinished(async () => {
      claude.dispose()
      await Promise.allSettled(opening ? [opening] : [])
      await adapter.closeAll()
      await adapter.drainObservedExits()
    })
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const connection = claude.connections[0]
    const exited = vi.spyOn(connection.handlers, 'onExit')
    const proof = vi.spyOn(connection.handlers, 'onMessage')
    const first = connection.initializationResult()
    expect(connection.initializationResult()).toBe(first)
    opening = claudeOpened(adapter, 'session-1')
    void opening.catch(() => {})
    connection.closed = true
    connection.handlers.onExit?.(new Error('Claude login required'))
    connection.initialization.reject(new Error('Query closed before response received'))
    await expect(opening).rejects.toThrow('Claude login required')
    await expect(first).rejects.toThrow('Query closed before response received')
    expect(connection.initializationResult()).toBe(first)
    expect(connection.sent).toEqual([])
    await adapter.drainObservedExits()
    const reads = connection.calls.length
    await connection.close()
    expect(connection.initializationResult()).toBe(first)
    expect(connection.calls).toHaveLength(reads + 1)
    expect(exited).toHaveBeenCalledOnce()
    expect(proof).not.toHaveBeenCalled()
  })

  it('refuses an unauthenticated initialize response even when SessionStart runs', async () => {
    const claude = fakeClaude({
      initProof: 'session-start',
      initAccount: { apiProvider: 'firstParty', tokenSource: 'none' }
    })
    const adapter = adapterAtPublishFor(claude)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    await expect(claudeOpened(adapter, 'session-1')).rejects.toThrow('not signed in')
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })
})

describe('ClaudeStructuredSessionAdapter acquisition cleanup', () => {
  async function exitedAfterPublish(
    exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  ): Promise<{ adapter: ClaudeStructuredSessionAdapter; connection: FakeConnection }> {
    const claude = fakeClaude({ unprovenCloseVerdict: exitVerdict })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))
    return { adapter, connection }
  }

  it.each(['unverifiable', 'live'] as const)(
    'classifies cleanup after a first-hand exit with its tree %s as a root exit, never as proven',
    async (tree) => {
      const { adapter, connection } = await exitedAfterPublish({ root: 'exited', tree })
      const error = await adapter.releaseAcquisition({ sessionId: 'session-1' }).catch((e) => e)

      expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
      expect((error as Error).message).toBe('claude stream-json exited (code 1): crashed')
      expect(connection.closeCount).toBe(2)
    }
  )

  it('forgets a retained exit once the session is acquired again', async () => {
    const options: Parameters<typeof fakeClaude>[0] = {}
    const claude = fakeClaude(options)
    const adapter = adapterAtPublishFor(claude, {
      resumesTranscript: true,
      continuesChain: true,
      resumeLeafUuid: 'tip'
    })
    let opening: Promise<unknown> | undefined
    onTestFinished(async () => {
      claude.dispose()
      await Promise.allSettled(opening ? [opening] : [])
      await adapter.closeAll()
    })
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    await claudeStartupSettled(adapter, 'session-1')
    const first = claude.connections[0]
    const proof = vi.spyOn(first.handlers, 'onMessage')
    const response = first.initializationResult()
    expect(first.initializationResult()).toBe(response)
    expect(proof).not.toHaveBeenCalled()
    first.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = async () => false
    options.holdInit = true

    const acquisition = adapter.acquire({
      identity: identityFor(),
      fence: 8,
      spawnToken: 'spawn-10'
    })
    opening = acquisition.then(() => claudeOpened(adapter, 'session-1'))
    void opening.catch(() => {})
    await acquisition
    const second = claude.connections[1]
    second.closed = true
    second.handlers.onExit?.(new Error('claude stream-json exited (code 1): not logged in'))
    second.initialization.reject(new Error('Query closed before response received'))
    await expect(opening).rejects.toThrow('not logged in')
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(first.closeCount).toBe(1)
    expect(first.initializationResult()).toBe(response)
    expect(proof).not.toHaveBeenCalled()
  })

  it('reports unproven published-session cleanup so callers can retry safely', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const connection = claude.connections[0]
    connection.close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) as unknown as FakeConnection['close']

    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(false)
    expect(await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
      current: { model: 'claude-sonnet-5' }
    })
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(() => adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toThrow(
      'no live claude stream-json session'
    )
  })

  it('names a settled exit to a late caller until the chat is acquired again', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    claude.connections[0].handlers.onExit?.(new Error('claude stream-json exited: not logged in'))
    await adapter.drainObservedExits()
    expect(() => adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toThrow('not logged in')

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(() => adapter.readOptions({ sessionId: 'session-1', fence: 8 })).toThrow(
      'no live claude stream-json session'
    )
  })

  it('forgets an exit the chat was closed over, even one that settles during the close', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const connection = claude.connections[0]
    const proof = Promise.withResolvers<boolean>()
    connection.close = vi
      .fn<FakeConnection['close']>()
      .mockImplementationOnce(() => proof.promise)
      .mockResolvedValue(true)
    connection.handlers.onExit?.(new Error('claude stream-json exited: not logged in'))
    await tick()

    const closing = adapter.closeSession('session-1')
    proof.resolve(true)
    await expect(closing).resolves.toBe(true)
    expect(() => adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toThrow(
      'no live claude stream-json session'
    )
  })

  it('starts the chat again after a crash whose root exited but whose descendants went unverified', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const first = claude.connections[0]
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = vi.fn<FakeConnection['close']>().mockResolvedValue(false)
    first.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))

    // Reacquire before queued exit publication to exercise synchronous settlement.
    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })

    expect(claude.connections).toHaveLength(2)
  })

  it('publishes a crash whose root exited but whose descendants went unverified', async () => {
    const claude = fakeClaude({ unprovenCloseVerdict: { root: 'exited', tree: 'unverifiable' } })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const connection = claude.connections[0]
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))
    await adapter.drainObservedExits()

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'ended', cause: 'unexpected-exit' })
    )
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
  })

  it('forgets the stored crash when the host acknowledges session release', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    claude.connections[0].handlers.onExit?.(new Error('retained crash'))
    await adapter.drainObservedExits()
    expect(() => adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toThrow(
      'retained crash'
    )
    adapter.acknowledgeSessionRelease('session-1')
    expect(() => adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toThrow(
      'no live claude stream-json session'
    )
  })

  it('keeps shutdown pending until a retained unexpected-exit proof settles', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const connection = claude.connections[0]
    const proof = Promise.withResolvers<boolean>()
    connection.close = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => proof.promise)
      .mockResolvedValueOnce(true) as unknown as FakeConnection['close']

    connection.handlers.onExit?.(new Error('crashed'))
    await tick()
    let settled = false
    const closing = adapter.closeAll().then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)

    proof.resolve(false)
    await expect(closing).resolves.toBeUndefined()
    expect(connection.close).toHaveBeenCalledTimes(2)
  })

  it('does not claim shutdown success for a retained false exit proof', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const connection = claude.connections[0]
    connection.close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false) as unknown as FakeConnection['close']

    connection.handlers.onExit?.(new Error('crashed'))
    await tick()

    await expect(adapter.closeAll()).rejects.toThrow(
      'claude structured session shutdown could not prove every child stopped'
    )
    expect(events.filter((event) => event.type === 'ended')).toEqual([])
    expect(connection.close).toHaveBeenCalledTimes(4)
  })
})

describe('ClaudeStructuredSessionAdapter prompts', () => {
  it('turns can_use_tool into an addressable durable approval that settles the SDK callback', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const answered = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' },
      suggestions: [{ type: 'addRules' }]
    })
    expect(events.at(-1)).toMatchObject({
      type: 'prompt',
      prompt: { kind: 'approval', toolName: 'Bash', promptKey: 'permission-1' }
    })

    adapter.bindPromptItemId('session-1', 'journal-approval', 'permission-1')
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-approval',
      kind: 'approval',
      response: { kind: 'option', optionId: 'allowForSession' },
      fence: 7,
      commit: async () => undefined
    })
    await expect(answered.promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
      updatedPermissions: [{ type: 'addRules' }],
      toolUseID: 'tool-1'
    })
  })

  it('settles the one AskUserQuestion callback from structured answers, including a long typed answer', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const answered = invokeCanUseTool(
      claude.connections[0],
      'AskUserQuestion',
      'question-1',
      'tool-question',
      {
        input: {
          questions: [
            { question: 'Library?', options: [{ label: 'Luxon' }] },
            { question: 'Ship now?', options: [{ label: 'Yes' }] }
          ]
        }
      }
    )
    adapter.bindPromptItemId('session-1', 'journal-question', 'question-1')
    const typed = 'Wait for the capture to finish first. '.repeat(60)

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-question',
      kind: 'question',
      response: {
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['q1:choice-1'] },
          { questionId: 'q2', optionIds: [], other: typed }
        ]
      },
      fence: 7,
      commit: async () => undefined
    })
    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Library?': 'Luxon', 'Ship now?': typed.trim() } },
      toolUseID: 'tool-question'
    })
  })

  it('refuses answers Claude cannot take before the journal commits them', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const answered = invokeCanUseTool(
      claude.connections[0],
      'AskUserQuestion',
      'question-1',
      'tool-question',
      { input: { questions: [{ question: 'Library?', options: [{ label: 'Luxon' }] }] } }
    )
    adapter.bindPromptItemId('session-1', 'journal-question', 'question-1')
    const commit = vi.fn(async () => undefined)

    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-question',
        kind: 'question',
        response: { kind: 'option', optionId: 'allow' },
        fence: 7,
        commit
      })
    ).rejects.toBeInstanceOf(AgentSessionPromptAnswerRejectedError)
    expect(commit).not.toHaveBeenCalled()

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-question',
      kind: 'question',
      response: { kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['q1:choice-1'] }] },
      fence: 7,
      commit
    })
    await expect(answered.promise).resolves.toMatchObject({
      updatedInput: { answers: { 'Library?': 'Luxon' } }
    })
  })

  it('leaves a prompt cancelled and unanswerable once the SDK abort signal fires', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const controller = new AbortController()
    const answered = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-9', 'tool-9', {
      input: { command: 'rm -rf /' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-9', 'permission-9')

    controller.abort()
    await expect(answered.promise).resolves.toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'prompt-cancelled', promptKey: 'permission-9' })
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-9',
        kind: 'approval',
        response: { kind: 'option', optionId: 'allow' },
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow(/no longer waiting/)
  })

  it('settles an in-flight permission callback when the session closes, leaving no dangling promise', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const answered = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-close', 'tool-c', {
      input: { command: 'ls' }
    })
    await tick()
    expect(answered.settled()).toBe(false)

    await adapter.closeSession('session-1')

    await expect(answered.promise).resolves.toBeNull()
  })
})
