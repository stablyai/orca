import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  acquired,
  adapterFor,
  deferred,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  USER_MESSAGE
} from './claude-structured-adapter-fake-connection'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'
import { encodeClaudeQuestionOptionId } from './claude-structured-prompt-replies'
import {
  CLAUDE_STRUCTURED_INIT_TIMEOUT_MS,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

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
  it('accepts a dispatch under the caller UUID written to Claude', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)

    const result = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    const sentUuid = claude.connections[0].sent[0]!.uuid
    expect(result).toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        uuid: sentUuid
      }
    })
    expect(claude.connections[0].sent[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] },
      session_id: PROVIDER_SESSION_ID
    })
  })

  it('accepts a successful write when no replay arrives', async () => {
    const adapter = await acquired(fakeClaude({ replayUuid: null }))
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'accepted' })
  })

  it('accepts when the exact echo arrives before the write rejects', async () => {
    const claude = fakeClaude({ sendErrorAfterReplay: new Error('flush failed') })
    const adapter = await acquired(claude)

    const result = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(result).toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: claude.connections[0].sent[0]!.uuid }
    })
  })

  it('suppresses a late exact echo after an unobserved write failure', async () => {
    const claude = fakeClaude({ replayUuid: null, sendError: new Error('broken pipe') })
    const bodies: AgentJournalItemBody[] = []
    const events: ClaudeStructuredSessionEvent[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'unknown', reason: 'broken pipe' })
    const sent = claude.connections[0].sent[0]!
    claude.connections[0].handlers.onMessage?.({ ...sent, isReplay: true })

    expect(bodies.filter((body) => body.kind === 'message' && body.role === 'user')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'message', message: { uuid: sent.uuid } })
  })

  it('settles only exact owned lifecycle and result identities', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const tombstones: string[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: () => undefined,
      appendTombstone: (identity) => {
        if (identity.provider === 'legacy') {
          tombstones.push(identity.recordId)
        }
      },
      publish: () => undefined
    }
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    for (const clientMessageId of ['a', 'b', 'c', 'd']) {
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId,
        body: USER_MESSAGE,
        fence: 7
      })
    }
    const [turnA, turnB, turnC, turnD] = claude.connections[0].sent.map(
      (frame) => frame.uuid as string
    )
    const emit = (message: Record<string, unknown>): void =>
      claude.connections[0].handlers.onMessage?.(message)

    emit({
      type: 'command_lifecycle',
      command_uuid: turnA,
      state: 'future-state',
      session_id: PROVIDER_SESSION_ID
    })
    emit({
      type: 'command_lifecycle',
      command_uuid: turnB,
      state: 'completed',
      session_id: 'another-session'
    })
    emit({ type: 'result', user_message_uuid: 'unknown', session_id: PROVIDER_SESSION_ID })
    expect(tombstones).toEqual([])

    emit({
      type: 'command_lifecycle',
      command_uuid: turnB,
      state: 'completed',
      session_id: PROVIDER_SESSION_ID
    })
    emit({
      type: 'command_lifecycle',
      command_uuid: turnC,
      state: 'cancelled',
      session_id: PROVIDER_SESSION_ID
    })
    emit({
      type: 'command_lifecycle',
      command_uuid: turnD,
      state: 'discarded',
      session_id: PROVIDER_SESSION_ID
    })
    emit({
      type: 'result',
      user_message_uuid: turnA,
      session_id: PROVIDER_SESSION_ID
    })

    expect(tombstones).toEqual([
      `turn-lifecycle:${turnB}`,
      `turn-lifecycle:${turnC}`,
      `turn-lifecycle:${turnD}`,
      `turn-lifecycle:${turnA}`
    ])
  })

  it.each(['queued', 'started'])('%s proves delivery without a journal sink', async (state) => {
    const claude = fakeClaude({
      replayUuid: null,
      onSend: (message, handlers) => {
        handlers.onMessage?.({
          type: 'command_lifecycle',
          command_uuid: message.uuid,
          state,
          session_id: PROVIDER_SESSION_ID
        })
        throw new Error('flush failed')
      }
    })
    const adapter = await acquired(claude)

    const result = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(result).toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: claude.connections[0].sent[0]?.uuid }
    })
  })

  it('isolates callbacks and owned UUIDs across same-provider-session reacquisition', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const persistedHandles: unknown[] = []
    const bodies: AgentJournalItemBody[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'old-client',
      body: USER_MESSAGE,
      fence: 7
    })
    const oldConnection = claude.connections[0]
    const oldFrame = oldConnection.sent[0]!

    await adapter.acquire({
      identity: identityFor(),
      fence: 8,
      spawnToken: 'spawn-10',
      events: sink
    })
    const eventCount = events.length
    oldConnection.handlers.onMessage?.({ ...oldFrame, isReplay: true })
    expect(events).toHaveLength(eventCount)

    claude.connections[1].handlers.onMessage?.({ ...oldFrame, isReplay: true })
    expect(bodies.filter((body) => body.kind === 'message' && body.role === 'user')).toHaveLength(1)
    await adapter.closeSession('session-1')
    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'init-uuid', fence: 8 })
  })

  it.each(['close', 'exit'] as const)(
    'wakes active and queued dispatches on session %s',
    async (termination) => {
      const pendingWrite = deferred()
      const claude = fakeClaude({ replayUuid: null, onSend: () => pendingWrite.promise })
      const adapter = await acquired(claude)
      const first = adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
      await vi.waitFor(() => expect(claude.connections[0].sent).toHaveLength(1))
      const second = adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-2',
        body: USER_MESSAGE,
        fence: 7
      })

      if (termination === 'close') {
        await adapter.closeSession('session-1')
      } else {
        claude.connections[0].handlers.onExit?.(new Error('provider exited'))
      }

      await expect(first).resolves.toMatchObject({ state: 'unknown' })
      await expect(second).resolves.toMatchObject({ state: 'rejected' })
      expect(claude.connections[0].sent).toHaveLength(1)
      pendingWrite.resolve()
    }
  )

  it('marks the session terminal before graceful-close persistence finishes', async () => {
    const pendingWrite = deferred()
    const pendingPersistence = deferred()
    const claude = fakeClaude({ replayUuid: null, onSend: () => pendingWrite.promise })
    const adapter = adapterFor(claude, {}, [], [], undefined, () => pendingPersistence.promise)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const dispatch = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    await vi.waitFor(() => expect(claude.connections[0].sent).toHaveLength(1))
    let closeFinished = false
    const close = adapter.closeSession('session-1').then(() => {
      closeFinished = true
    })

    await expect(dispatch).resolves.toMatchObject({ state: 'unknown' })
    expect(closeFinished).toBe(false)
    pendingPersistence.resolve()
    await close
    pendingWrite.resolve()
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
