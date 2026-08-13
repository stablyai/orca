import { describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'
import { encodeClaudeQuestionOptionId } from './claude-structured-prompt-replies'
import {
  CLAUDE_STRUCTURED_INIT_TIMEOUT_MS,
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredLaunch,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

const PROVIDER_SESSION_ID = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

function identityFor(sessionId = 'session-1'): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  }
}

type Route = (params: Record<string, unknown> | undefined) => unknown

type FakeConnection = Omit<ClaudeStreamJsonConnection, 'closed'> & {
  closed: boolean
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
  replies: { requestId: string; response?: unknown; error?: string }[]
  closeCount: number
}

function fakeClaude(
  options: {
    initSessionId?: string
    initUuid?: string
    initModel?: string
    initEffort?: string
    initProof?: 'init' | 'session-start' | 'none'
    initAccount?: unknown
    exitBeforeInit?: string
    settings?: unknown
    replayUuid?: string | null
    routes?: Record<string, Route>
  } = {}
): {
  connections: FakeConnection[]
  openConnection: typeof openClaudeStreamJsonConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const routes = options.routes ?? {}
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      replies: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: async (subtype, params) => {
        connection.calls.push({ subtype, params })
        if (subtype === 'initialize') {
          if (options.exitBeforeInit) {
            handlers.onExit?.(new Error(options.exitBeforeInit))
            return { models: [] }
          }
          if (options.initProof === 'session-start') {
            handlers.onMessage?.({
              type: 'system',
              subtype: 'hook_started',
              hook_name: 'SessionStart:startup',
              session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
              uuid: options.initUuid ?? 'init-uuid'
            })
          } else if (options.initProof !== 'none') {
            handlers.onMessage?.({
              type: 'system',
              subtype: 'init',
              session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
              uuid: options.initUuid ?? 'init-uuid',
              model: options.initModel ?? 'claude-sonnet-5',
              effortLevel: options.initEffort ?? 'high',
              apiKeySource: 'none'
            })
          }
          return {
            models: [{ value: 'claude-sonnet', displayName: 'Sonnet' }],
            ...(options.initAccount === undefined ? {} : { account: options.initAccount })
          }
        }
        if (subtype === 'get_settings') {
          return options.settings ?? { env: {} }
        }
        const route = routes[subtype]
        return route ? route(params) : {}
      },
      send: async (message) => {
        connection.sent.push(message)
        if (message.type === 'user' && options.replayUuid !== null) {
          handlers.onMessage?.({
            ...message,
            uuid: options.replayUuid ?? 'user-uuid'
          })
        }
      },
      respond: async (requestId, response) => {
        connection.replies.push({ requestId, response })
      },
      respondWithError: async (requestId, error) => {
        connection.replies.push({ requestId, error })
      },
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openClaudeStreamJsonConnection
  return { connections, openConnection, routes }
}

function adapterFor(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {},
  events: ClaudeStructuredSessionEvent[] = [],
  persistedHandles: unknown[] = [],
  initTimeoutMs?: number
): ClaudeStructuredSessionAdapter {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'claude',
      args: ['-p'],
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumed: false,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    ...(initTimeoutMs === undefined ? {} : { initTimeoutMs }),
    dispatchAckTimeoutMs: 10,
    persistHandle: async (handle) => {
      persistedHandles.push(handle)
    }
  })
}

async function acquired(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {},
  events: ClaudeStructuredSessionEvent[] = []
): Promise<ClaudeStructuredSessionAdapter> {
  const adapter = adapterFor(claude, launch, events)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
  return adapter
}

describe('ClaudeStructuredSessionAdapter.acquire', () => {
  it('finishes its startup deadline before the paired mobile request deadline', () => {
    expect(CLAUDE_STRUCTURED_INIT_TIMEOUT_MS).toBeLessThan(30_000)
  })

  it('pins the account, proves init, and reports the process and chain leaf', async () => {
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
    expect(claude.connections[0].calls.slice(0, 2)).toEqual([
      { subtype: 'initialize', params: { supportedDialogKinds: [] } },
      { subtype: 'get_settings', params: {} }
    ])
    expect(acquisition.process).toEqual({
      hostId: 'host-1',
      pid: 4321,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-9'
    })
    expect(acquisition.link).toEqual({
      linkId: `claude-7-${PROVIDER_SESSION_ID}-init-uuid`,
      handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'init-uuid' },
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

    expect(claude.connections[0].calls.slice(-2)).toEqual([
      { subtype: 'set_model', params: { model: 'opus' } },
      { subtype: 'apply_flag_settings', params: { settings: { effortLevel: 'high' } } }
    ])
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'opus', effort: 'high' }
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

  it('accepts SessionStart as the pre-turn session proof from the real CLI protocol', async () => {
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
      leafUuid: 'session-start-uuid'
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
      leafUuid: 'init-uuid'
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
    expect(claude.connections[0].calls[0]).toEqual({
      subtype: 'initialize',
      params: { supportedDialogKinds: [] }
    })
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
        list_models: () => ({
          models: [
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
        })
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
      current: { model: 'sonnet', effort: 'high' }
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
    expect(result.current).toEqual({ model: 'custom-model', effort: 'high' })
  })
})

describe('ClaudeStructuredSessionAdapter prompts', () => {
  it('turns can_use_tool into an addressable durable approval callback', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    claude.connections[0].handlers.onControlRequest?.({
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        input: { command: 'git status' },
        permission_suggestions: [{ type: 'addRules' }]
      }
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
    expect(claude.connections[0].replies).toEqual([
      {
        requestId: 'permission-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'git status' },
          updatedPermissions: [{ type: 'addRules' }],
          toolUseID: 'tool-1'
        }
      }
    ])
  })

  it('collects every AskUserQuestion card before answering the one callback', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    claude.connections[0].handlers.onControlRequest?.({
      type: 'control_request',
      request_id: 'question-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tool-question',
        input: {
          questions: [
            { question: 'Library?', options: [{ label: 'Luxon' }] },
            { question: 'Ship now?', options: [{ label: 'Yes' }] }
          ]
        }
      }
    })
    adapter.bindPromptItemId('session-1', 'journal-q1', 'question-1', 'Library?')
    adapter.bindPromptItemId('session-1', 'journal-q2', 'question-1', 'Ship now?')

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-q1',
      kind: 'question',
      optionId: encodeClaudeQuestionOptionId('Library?', 'Luxon'),
      fence: 7
    })
    expect(claude.connections[0].replies).toEqual([])
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-q2',
      kind: 'question',
      optionId: encodeClaudeQuestionOptionId('Ship now?', 'Yes'),
      fence: 7
    })
    expect(claude.connections[0].replies[0]).toMatchObject({
      requestId: 'question-1',
      response: {
        behavior: 'allow',
        updatedInput: { answers: { 'Library?': 'Luxon', 'Ship now?': 'Yes' } },
        toolUseID: 'tool-question'
      }
    })
  })

  it('persists the last observed leaf before graceful close', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistedHandles: unknown[] = []
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'result',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'final-leaf'
    })

    await adapter.closeSession('session-1')

    expect(persistedHandles).toEqual([
      {
        sessionId: 'session-1',
        providerSessionId: PROVIDER_SESSION_ID,
        leafUuid: 'final-leaf',
        fence: 7
      }
    ])
    expect(events.at(-2)).toEqual({
      type: 'handle',
      sessionId: 'session-1',
      providerSessionId: PROVIDER_SESSION_ID,
      leafUuid: 'final-leaf',
      fence: 7
    })
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
