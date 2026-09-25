import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'
import { encodeClaudeQuestionOptionId } from './claude-structured-prompt-replies'
import type {
  ClaudeStructuredSessionAdapter,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  acquired,
  adapterFor,
  fakeClaude,
  identityFor,
  invokeCanUseTool,
  PROVIDER_SESSION_ID,
  tick,
  USER_MESSAGE,
  type FakeConnection
} from './claude-structured-session-test-support'

describe('ClaudeStructuredSessionAdapter.acquire', () => {
  it('pins the account and proves init without treating the system-frame uuid as a chain leaf', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)

    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(claude.connections[0].launch).toMatchObject({
      cwd: '/work/repo',
      env: {
        [CLAUDE_SPAWN_TOKEN_ENV]: 'spawn-9',
        CLAUDE_CONFIG_DIR: '/accounts/claude'
      }
    })
    // supportedDialogKinds is now a query() launch option, not an initialize request param.
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
    expect(acquisition.link).toEqual({
      linkId: `claude-7-${PROVIDER_SESSION_ID}-empty`,
      handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      origin: 'created',
      mintedAtFence: 7,
      observedAt: 1_700_000_000_500
    })
    expect(events[0]).toMatchObject({ type: 'message', message: { subtype: 'init' } })
  })

  it('restores persisted model and effort before publishing a reacquired session', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude, { resumesTranscript: true, continuesChain: true })

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', effort: 'high' }
    })

    expect(claude.connections[0].calls.slice(-4)).toEqual([
      { subtype: 'set_model', params: { model: 'opus' } },
      // The restored model's advertised levels gate the replay, so a stale effort
      // is dropped rather than re-applied to a model with no effort control.
      { subtype: 'list_models' },
      { subtype: 'apply_flag_settings', params: { settings: { effortLevel: 'high' } } },
      // The effort is only recorded once the child reports having adopted it.
      { subtype: 'get_settings' }
    ])
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'opus', effort: 'high' }
    })
  })

  it('restores an encoded Fast preference through the absolute flag setting', async () => {
    const claude = fakeClaude({
      settings: { effective: { fastMode: false, fastModePerSessionOptIn: false } },
      routes: {
        list_models: () => [{ value: 'opus', displayName: 'Opus', supportsFastMode: true }]
      }
    })
    const adapter = adapterFor(claude)

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', fastMode: 'true' }
    })

    expect(claude.connections[0].calls).toContainEqual({
      subtype: 'apply_flag_settings',
      params: { settings: { fastMode: true } }
    })
  })

  it('does not carry a saved opt-in into a new per-session-opt-in child', async () => {
    const claude = fakeClaude({
      settings: { effective: { fastMode: false, fastModePerSessionOptIn: true } },
      routes: {
        list_models: () => [{ value: 'opus', displayName: 'Opus', supportsFastMode: true }]
      }
    })
    const adapter = adapterFor(claude)

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', fastMode: 'true' }
    })

    expect(
      claude.connections[0].calls.filter((call) => call.subtype === 'apply_flag_settings')
    ).toEqual([])
  })

  it('restores Fast when reacquiring the same per-session-opt-in conversation', async () => {
    const claude = fakeClaude({
      settings: { effective: { fastMode: false, fastModePerSessionOptIn: true } },
      routes: {
        list_models: () => [{ value: 'opus', displayName: 'Opus', supportsFastMode: true }]
      }
    })
    const adapter = adapterFor(claude, { resumesTranscript: true, continuesChain: true })

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'opus', fastMode: 'true' }
    })

    expect(claude.connections[0].calls).toContainEqual({
      subtype: 'apply_flag_settings',
      params: { settings: { fastMode: true } }
    })
  })

  it('self-heals a Fast preference the running model no longer supports', async () => {
    const claude = fakeClaude({
      settings: { effective: { fastMode: false } },
      routes: {
        list_models: () => [{ value: 'opus', displayName: 'Opus', supportsFastMode: false }]
      }
    })
    const adapter = adapterFor(claude)

    await expect(
      adapter.acquire({
        identity: identityFor(),
        fence: 7,
        spawnToken: 'spawn-9',
        options: { model: 'opus', fastMode: 'true' }
      })
    ).resolves.toBeDefined()

    expect(adapter.readOptionRestoreFailures('session-1')).toContain('fastMode')
    expect(
      claude.connections[0].calls.filter((call) => call.subtype === 'apply_flag_settings')
    ).toEqual([])
  })

  it.each([
    ['model', 'set_model', { model: 'retired-model' }],
    ['effort', 'apply_flag_settings', { effort: 'retired-effort' }],
    ['permissionMode', 'set_permission_mode', { permissionMode: 'retired-mode' }]
  ] as const)(
    'self-heals a persisted %s rejected during restore',
    async (key, subtype, options) => {
      const claude = fakeClaude({
        routes: {
          [subtype]: () => {
            throw new ClaudeControlRequestError(subtype, 'value is no longer available')
          }
        }
      })
      const adapter = adapterFor(claude)

      await expect(
        adapter.acquire({
          identity: identityFor(),
          fence: 7,
          spawnToken: 'spawn-9',
          options
        })
      ).resolves.toBeDefined()
      expect(adapter.readOptionRestoreFailures('session-1')).toEqual([key])
    }
  )

  it('does not treat a transport timeout while restoring an option as recoverable', async () => {
    const claude = fakeClaude({
      routes: {
        set_model: () => {
          throw new Error('claude set_model request timed out')
        }
      }
    })
    const input = {
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'temporarily-unavailable' }
    }

    // Restore runs after publish, so its failure ends the session rather than the create.
    await expect(endedAtStartup(claude, input)).resolves.toMatchObject({
      reason: 'claude set_model request timed out',
      startupUnproven: true
    })
    expect(claude.connections[0]?.closeCount).toBe(1)
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
    ).resolves.toEqual({ state: 'admitted' })
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
      ).resolves.toEqual({ state: 'admitted' })
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
    ).resolves.toEqual({ state: 'admitted' })
    expect(connection.sent).toHaveLength(1)
    connection.handlers.onMessage?.({
      ...connection.sent[0],
      uuid: 'foreign-replay',
      session_id: 'foreign-provider-session'
    })
    await Promise.resolve()
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1)
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
        [CLAUDE_SPAWN_TOKEN_ENV]: 'wrong-token'
      }
    })

    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    expect(claude.connections[0].launch.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CONFIG_DIR: '/accounts/claude',
      [CLAUDE_SPAWN_TOKEN_ENV]: 'spawn-9'
    })
  })

  it('leaves CLAUDE_CONFIG_DIR unset when the account home is the CLI default', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude, { claudeConfigDir: join(homedir(), '.claude'), env: {} })

    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    // Pinning the CLI's own default suppresses the macOS Keychain and breaks claude.ai login.
    expect(claude.connections[0].launch.env).toEqual({ [CLAUDE_SPAWN_TOKEN_ENV]: 'spawn-9' })
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
      [CLAUDE_SPAWN_TOKEN_ENV]: 'spawn-9'
    })
  })

  it('accepts SessionStart as pre-turn proof without treating its system uuid as a leaf', async () => {
    const claude = fakeClaude({ initProof: 'session-start', initUuid: 'session-start-uuid' })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)

    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(acquisition.link.handle).toEqual({
      provider: 'claude',
      sessionId: PROVIDER_SESSION_ID,
      leafUuid: null
    })
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
    const acquisition = await resumed.acquire({
      identity: identityFor(),
      fence: 9,
      spawnToken: 'spawn-9'
    })
    expect(acquisition.link.origin).toBe('resumed')
    expect(acquisition.link.handle).toEqual({
      provider: 'claude',
      sessionId: PROVIDER_SESSION_ID,
      leafUuid: 'leaf-before'
    })

    const wrongClaude = fakeClaude({ initSessionId: 'different-session' })
    await expect(endedAtStartup(wrongClaude)).resolves.toMatchObject({
      reason: expect.stringMatching(/expected/),
      startupUnproven: true
    })
    expect(wrongClaude.connections[0].closeCount).toBe(1)
  })

  it('fails the acquire with the CLI diagnostic when the exit lands before the handover', async () => {
    // No init delay: the child dies inside the initialize call, before acquire can return it.
    const claude = fakeClaude({ exitBeforeInit: 'Claude login required' })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)

    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('Claude login required')
    await adapter.drainObservedExits()

    // The published-then-ended path is the slow-init case in the startup suite. The first-hand
    // exit is still reported as it was seen; the host holds no session under it to end.
    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: 'Claude login required',
      cause: 'unexpected-exit',
      startupUnproven: true
    })
    expect(claude.connections[0].closeCount).toBeGreaterThanOrEqual(1)
  })

  it('refuses an unauthenticated initialize response even when SessionStart runs', async () => {
    const claude = fakeClaude({
      initProof: 'session-start',
      initAccount: { apiProvider: 'firstParty', tokenSource: 'none' }
    })

    await expect(endedAtStartup(claude)).resolves.toMatchObject({
      reason: expect.stringMatching(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s),
      startupUnproven: true
    })
    expect(claude.connections[0].closeCount).toBe(1)
  })
})

/** Acquires, then returns the `ended` event the startup failure published. */
async function endedAtStartup(
  claude: ReturnType<typeof fakeClaude>,
  input: Parameters<ClaudeStructuredSessionAdapter['acquire']>[0] = {
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9'
  },
  launch: Parameters<typeof adapterFor>[1] = {}
): Promise<ClaudeStructuredSessionEvent | undefined> {
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterFor(claude, launch, events)
  await adapter.acquire(input)
  await adapter.drainObservedExits()
  return events.find((event) => event.type === 'ended')
}

describe('ClaudeStructuredSessionAdapter acquisition cleanup', () => {
  /** A start that fails after the child self-exited, with its close verdict scripted. */
  function failedStart(
    unprovenCloseVerdict: ClaudeStreamJsonConnection['exitVerdict']
  ): Promise<unknown> {
    const claude = fakeClaude({
      exitBeforeInit: 'claude stream-json exited (code 1): not logged in',
      unprovenCloseVerdict
    })
    return adapterFor(claude, {
      resumesTranscript: true,
      continuesChain: true,
      resumeLeafUuid: 'tip'
    })
      .acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
      .catch((error: unknown) => error)
  }

  // The root's pid and start time are the lease's identity, and they are provably dead: latching
  // the session would strand a signed-out user. A descendant seen alive is not the conversation's
  // writer, so it does not hold the session either.
  it.each(['unverifiable', 'live'] as const)(
    'releases on a first-hand root exit with its tree %s while still carrying the CLI diagnostic',
    async (tree) => {
      const error = await failedStart({ root: 'exited', tree })

      expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
      expect((error as Error).message).toBe('claude stream-json exited (code 1): not logged in')
    }
  )

  it('never releases for a root Orca never saw leave', async () => {
    const error = await failedStart({ root: 'live', tree: 'unverifiable' })

    expect(error).toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
    expect(error).not.toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  })

  /** A published session whose CLI then exits first-hand, with the verdict its ladder holds. */
  async function exitedAfterPublish(
    exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  ): Promise<{ adapter: ClaudeStructuredSessionAdapter; connection: FakeConnection }> {
    const claude = fakeClaude({ unprovenCloseVerdict: exitVerdict })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))
    return { adapter, connection }
  }

  // The host may still be committing or proving the lease when the child dies; its cleanup must
  // find the exit the ladder observed, not an absence.
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
    const adapter = adapterFor(claude, {
      resumesTranscript: true,
      continuesChain: true,
      resumeLeafUuid: 'tip'
    })
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const first = claude.connections[0]
    first.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = async () => false
    options.exitBeforeInit = 'claude stream-json exited (code 1): not logged in'

    await expect(
      adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })
    ).rejects.toThrow('not logged in')
    // The second start's own proven close is the answer; the first exit is stale.
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(first.closeCount).toBe(1)
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

    // Before the exit publishes, the start settles it itself rather than refusing on it.
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

    // The owner releases the lease on a root exit, so the host must hear of it now, as of a proven one.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'ended', cause: 'unexpected-exit' })
    )
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
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
      optionId: 'allowForSession',
      fence: 7,
      commit: async () => undefined
    })
    // The answer resolves the SDK's own callback promise; the SDK writes the wire response.
    await expect(answered.promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
      updatedPermissions: [{ type: 'addRules' }],
      toolUseID: 'tool-1'
    })
  })

  it('collects every AskUserQuestion card before settling the one callback', async () => {
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
    adapter.bindPromptItemId('session-1', 'journal-q1', 'question-1', 'Library?')
    adapter.bindPromptItemId('session-1', 'journal-q2', 'question-1', 'Ship now?')

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-q1',
      kind: 'question',
      optionId: encodeClaudeQuestionOptionId('Library?', 'Luxon'),
      fence: 7,
      commit: async () => undefined
    })
    await tick()
    expect(answered.settled()).toBe(false)
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-q2',
      kind: 'question',
      optionId: encodeClaudeQuestionOptionId('Ship now?', 'Yes'),
      fence: 7,
      commit: async () => undefined
    })
    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Library?': 'Luxon', 'Ship now?': 'Yes' } },
      toolUseID: 'tool-question'
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
    // A cancelled request is forgotten and settled with null — never an authorization.
    await expect(answered.promise).resolves.toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'prompt-cancelled', promptKey: 'permission-9' })
    // A late answer after the abort must not authorize the wrong tool.
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-9',
        kind: 'approval',
        optionId: 'allow',
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
