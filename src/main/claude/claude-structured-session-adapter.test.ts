import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'
import { encodeClaudeQuestionOptionId } from './claude-structured-prompt-replies'
import {
  CLAUDE_STRUCTURED_INIT_TIMEOUT_MS,
  type ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
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
  it('finishes its startup deadline before the paired mobile request deadline', () => {
    expect(CLAUDE_STRUCTURED_INIT_TIMEOUT_MS).toBeLessThan(30_000)
  })

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
    const adapter = adapterFor(claude, { resumed: true })

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
    const adapter = adapterFor(claude)
    const input = {
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'temporarily-unavailable' }
    }

    await expect(adapter.acquire(input)).rejects.toThrow('claude set_model request timed out')
    expect(claude.connections[0]?.closeCount).toBe(1)
  })

  it('recovers a cancellable lifecycle when a timed-out replay arrives late', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'unknown' })
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
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'late-turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
  })

  it('quarantines SDK frames without the acquired session identity', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
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

    const dispatch = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    await Promise.resolve()
    expect(connection.sent).toHaveLength(1)
    connection.handlers.onMessage?.({
      ...connection.sent[0],
      uuid: 'foreign-replay',
      session_id: 'foreign-provider-session'
    })
    await Promise.resolve()
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1)

    connection.handlers.onMessage?.({
      ...connection.sent[0],
      session_id: PROVIDER_SESSION_ID
    })
    await expect(dispatch).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: connection.sent[0]!.uuid }
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
      resumed: true,
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
    const wrong = adapterFor(wrongClaude)
    await expect(
      wrong.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow(/expected/)
    expect(wrongClaude.connections[0].closeCount).toBe(1)
  })

  it('surfaces a CLI startup failure instead of waiting for the init deadline', async () => {
    const claude = fakeClaude({ exitBeforeInit: 'Claude login required' })
    const adapter = adapterFor(claude)

    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('Claude login required')
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('closes a silent unauthenticated startup with actionable account guidance', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const adapter = adapterFor(claude, {}, [], [], 20)

    const error = await adapter
      .acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AgentSessionAcquisitionRefusal)
    expect(error).toMatchObject({
      message: expect.stringMatching(/selected Claude account is signed in.*CLAUDE_CONFIG_DIR/s)
    })
    expect(claude.connections[0].calls[0]).toEqual({ subtype: 'initialize' })
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('refuses an unauthenticated initialize response even when SessionStart runs', async () => {
    const claude = fakeClaude({
      initProof: 'session-start',
      initAccount: { apiProvider: 'firstParty', tokenSource: 'none' }
    })
    const adapter = adapterFor(claude)

    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s)
    expect(claude.connections[0].closeCount).toBe(1)
  })
})

describe('ClaudeStructuredSessionAdapter turns and controls', () => {
  it('accepts a dispatch only after Claude replays its provider uuid', async () => {
    const claude = fakeClaude({ replayUuid: 'user-provider-uuid' })
    const adapter = await acquired(claude)

    const result = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(result).toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        uuid: 'user-provider-uuid'
      }
    })
    expect(claude.connections[0].sent[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] },
      session_id: PROVIDER_SESSION_ID
    })
  })

  it('leaves delivery unconfirmed when no replay uuid arrives', async () => {
    const adapter = await acquired(fakeClaude({ replayUuid: null }))
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'unknown' })
  })

  it('requires an acknowledged interrupt and supports controlled options', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'sonnet', fence: 7 })
    ).resolves.toEqual({ model: 'sonnet' })
    expect(claude.connections[0].calls.slice(-2)).toEqual([
      { subtype: 'interrupt', params: {} },
      { subtype: 'set_model', params: { model: 'sonnet' } }
    ])

    claude.routes.interrupt = () => {
      throw new ClaudeControlRequestError('interrupt', 'not running')
    }
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-2', fence: 7 })
    ).resolves.toEqual({ cancelled: false })

    claude.routes.interrupt = () => {
      throw new Error('claude interrupt request timed out')
    }
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-3', fence: 7 })
    ).rejects.toThrow('timed out')
  })

  it('does not let a delayed cancellation for an earlier turn interrupt the later turn', async () => {
    const claude = fakeClaude({ replayUuids: ['turn-T', 'turn-U'] })
    const adapter = await acquired(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-T',
      body: USER_MESSAGE,
      fence: 7
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-U',
      body: USER_MESSAGE,
      fence: 7
    })

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-T', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(claude.connections[0].calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(
      0
    )

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-U', fence: 6 })
    ).resolves.toEqual({ cancelled: false })

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-U', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(claude.connections[0].calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(
      1
    )
  })

  it('does not cancel an acknowledged turn after a later dispatch returns unknown', async () => {
    const claude = fakeClaude({ replayUuids: ['turn-T', null] })
    const adapter = await acquired(claude)

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-T',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'turn-T' }
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-U',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    expect(claude.connections[0].sent).toHaveLength(2)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-T', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(claude.connections[0].calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(
      0
    )
  })

  it('classifies provider-declined options without treating timeouts as settled', async () => {
    const claude = fakeClaude({
      routes: {
        set_model: () => {
          throw new ClaudeControlRequestError('set_model', 'model unavailable')
        }
      }
    })
    const adapter = await acquired(claude)

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'fable', fence: 7 })
    ).rejects.toMatchObject({ name: 'AgentSessionOptionRejectedError' })
    claude.routes.set_model = () => {
      throw new Error('claude set_model request timed out')
    }
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    ).rejects.toThrow('timed out')
  })

  it('hydrates live model choices and maps the resolved current model to its CLI id', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: {
        list_models: () => [
          { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default' },
          {
            value: 'opus',
            resolvedModel: 'claude-opus-5',
            displayName: 'Opus',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high']
          },
          {
            value: 'sonnet',
            resolvedModel: 'claude-sonnet-5',
            displayName: 'Sonnet'
          }
        ]
      }
    })
    const adapter = await acquired(claude)

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
      ],
      current: { model: 'sonnet', effort: 'high', confirmed: ['model', 'effort'] }
    })
  })

  it('keeps the shared Claude seed when live model discovery is unavailable', async () => {
    const claude = fakeClaude({
      initModel: 'custom-model',
      routes: {
        list_models: () => {
          throw new Error('unsupported')
        }
      }
    })
    const adapter = await acquired(claude)
    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })

    expect(result.models.map((model) => model.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'custom-model'
    ])
    expect(result.current).toEqual({
      model: 'custom-model',
      effort: 'high',
      confirmed: ['model', 'effort']
    })
  })
})

describe('ClaudeStructuredSessionAdapter acquisition cleanup', () => {
  /** A start that fails after the child self-exited, with its close verdict scripted. */
  function failedStart(
    unprovenCloseVerdict: ClaudeStreamJsonConnection['exitVerdict']
  ): Promise<unknown> {
    const claude = fakeClaude({
      exitBeforeInit: 'claude stream-json exited (code 1): not logged in',
      unprovenCloseVerdict
    })
    return adapterFor(claude)
      .acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
      .catch((error: unknown) => error)
  }

  it('releases on a first-hand root exit while still carrying the CLI diagnostic', async () => {
    // The root's pid and start time are the lease's identity, and they are
    // provably dead: latching the session would strand a signed-out user.
    const error = await failedStart({ root: 'exited', tree: 'unverifiable' })

    expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect((error as Error).message).toBe('claude stream-json exited (code 1): not logged in')
  })

  it('never releases while a descendant was observed alive', async () => {
    const error = await failedStart({ root: 'exited', tree: 'live' })

    expect(error).toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
    expect(error).not.toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  })

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

  it('classifies cleanup after a first-hand exit removed the session as a root exit, never as proven', async () => {
    // The host may still be committing or proving the lease when the child dies;
    // its cleanup must find the exit the ladder observed, not an absence.
    const { adapter, connection } = await exitedAfterPublish({
      root: 'exited',
      tree: 'unverifiable'
    })
    const error = await adapter.releaseAcquisition({ sessionId: 'session-1' }).catch((e) => e)

    expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect((error as Error).message).toBe('claude stream-json exited (code 1): crashed')
    expect(connection.closeCount).toBe(2)
  })

  it('never releases after an exit that left a descendant observed alive', async () => {
    const { adapter } = await exitedAfterPublish({ root: 'exited', tree: 'live' })
    const error = await adapter.releaseAcquisition({ sessionId: 'session-1' }).catch((e) => e)

    expect(error).toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
    expect(error).not.toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  })

  it('forgets a retained exit once the session is acquired again', async () => {
    const options: Parameters<typeof fakeClaude>[0] = {}
    const claude = fakeClaude(options)
    const adapter = await acquired(claude)
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

  it('does not report a second release as successful while retained exit evidence is unproven', async () => {
    const claude = fakeClaude({ unprovenCloseVerdict: { root: 'exited', tree: 'unverifiable' } })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))
    connection.close = vi.fn().mockResolvedValue(false) as unknown as FakeConnection['close']

    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
    expect(connection.close).toHaveBeenCalledTimes(2)
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
      fence: 7
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
      fence: 7
    })
    await tick()
    expect(answered.settled()).toBe(false)
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-q2',
      kind: 'question',
      optionId: encodeClaudeQuestionOptionId('Ship now?', 'Yes'),
      fence: 7
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
        fence: 7
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
