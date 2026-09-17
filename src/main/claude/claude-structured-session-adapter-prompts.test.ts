import { describe, expect, it, vi } from 'vitest'
import { encodeClaudeQuestionOptionId } from './claude-structured-prompt-replies'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import {
  acquired,
  fakeClaude,
  invokeCanUseTool,
  tick,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'

describe('ClaudeStructuredSessionAdapter prompts', () => {
  it('restores and durably settles the prior permission mode after ExitPlanMode approval', async () => {
    let permissionMode = 'acceptEdits'
    const writtenModes: string[] = []
    const order: string[] = []
    const claude = fakeClaude({
      initPermissionMode: 'acceptEdits',
      routes: {
        get_settings: () => ({ applied: { permissionMode } }),
        set_permission_mode: (params) => {
          permissionMode = String(params?.mode)
          writtenModes.push(permissionMode)
          if (permissionMode === 'acceptEdits') {
            order.push('restore-started')
          }
        }
      }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({
      sessionId: 'session-1',
      key: 'permissionMode',
      value: 'plan',
      fence: 7
    })
    const answered = invokeCanUseTool(
      claude.connections[0],
      'ExitPlanMode',
      'exit-plan-allow',
      'tool-allow'
    )
    adapter.bindPromptItemId('session-1', 'journal-allow', 'exit-plan-allow')
    let answerSettled = false
    void answered.promise.then(() => {
      answerSettled = true
      order.push('prompt-resolved')
    })
    const durableSettlement = Promise.withResolvers<void>()
    const settleOptions = vi.fn(async () => {
      order.push('settlement-started')
      await durableSettlement.promise
    })

    const commit = vi.fn(async () => {})
    const answering = adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-allow',
      kind: 'approval',
      optionId: 'allow',
      fence: 7,
      commit,
      settleOptions
    })

    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow'
    })
    expect(commit).toHaveBeenCalledWith({ options: { permissionMode: 'acceptEdits' } })
    expect(answerSettled).toBe(true)
    expect(writtenModes).toEqual(['plan', 'acceptEdits'])
    await vi.waitFor(() =>
      expect(settleOptions).toHaveBeenCalledWith({ permissionMode: 'acceptEdits' })
    )
    expect(order).toEqual(['restore-started', 'prompt-resolved', 'settlement-started'])
    let adapterSettled = false
    void answering.then(() => {
      adapterSettled = true
    })
    await tick()
    expect(adapterSettled).toBe(false)
    durableSettlement.resolve()
    await answering
    expect(settleOptions).toHaveBeenLastCalledWith({})
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      permissionModeRestoreValue: 'acceptEdits',
      current: { permissionMode: 'acceptEdits' }
    })
  })

  it.each(['deny', 'cancel'] as const)(
    'keeps plan mode after an ExitPlanMode %s answer',
    async (decision) => {
      let permissionMode = 'acceptEdits'
      const writtenModes: string[] = []
      const claude = fakeClaude({
        initPermissionMode: 'acceptEdits',
        routes: {
          get_settings: () => ({ applied: { permissionMode } }),
          set_permission_mode: (params) => {
            permissionMode = String(params?.mode)
            writtenModes.push(permissionMode)
          }
        }
      })
      const adapter = await acquired(claude)
      await adapter.setOption({
        sessionId: 'session-1',
        key: 'permissionMode',
        value: 'plan',
        fence: 7
      })
      const answered = invokeCanUseTool(
        claude.connections[0],
        'ExitPlanMode',
        `exit-plan-${decision}`,
        `tool-${decision}`
      )
      adapter.bindPromptItemId('session-1', `journal-${decision}`, `exit-plan-${decision}`)
      const settleOptions = vi.fn(async () => {})

      await adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: `journal-${decision}`,
        kind: 'approval',
        optionId: decision,
        fence: 7,
        commit: async () => {},
        settleOptions
      })
      await tick()

      await expect(answered.promise).resolves.toMatchObject({ behavior: 'deny' })
      expect(writtenModes).toEqual(['plan'])
      expect(settleOptions).not.toHaveBeenCalled()
      await expect(
        adapter.readOptions({ sessionId: 'session-1', fence: 7 })
      ).resolves.toMatchObject({ current: { permissionMode: 'plan' } })
    }
  )

  it('rejects external permission changes after send admission and during its turn', async () => {
    let permissionMode = 'acceptEdits'
    const claude = fakeClaude({
      initPermissionMode: 'acceptEdits',
      routes: {
        get_settings: () => ({ applied: { permissionMode } }),
        set_permission_mode: (params) => {
          permissionMode = String(params?.mode)
        }
      }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({
      sessionId: 'session-1',
      key: 'permissionMode',
      value: 'plan',
      fence: 7
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'planning-turn',
      body: USER_MESSAGE,
      fence: 7
    })

    await expect(
      adapter.setOption({
        sessionId: 'session-1',
        key: 'permissionMode',
        value: 'acceptEdits',
        fence: 7
      })
    ).rejects.toThrow('cannot change while a turn or send is unsettled')

    const sent = claude.connections[0]!.sent[0]!
    claude.connections[0]!.handlers.onMessage?.({ ...sent, uuid: 'planning-turn-provider' })

    await expect(
      adapter.setOption({
        sessionId: 'session-1',
        key: 'permissionMode',
        value: 'acceptEdits',
        fence: 7
      })
    ).rejects.toThrow('cannot change while a turn or send is unsettled')

    const answered = invokeCanUseTool(
      claude.connections[0],
      'ExitPlanMode',
      'exit-plan-live-turn',
      'tool-live-turn'
    )
    adapter.bindPromptItemId('session-1', 'journal-live-turn', 'exit-plan-live-turn')
    const settleOptions = vi.fn(async () => {})
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-live-turn',
      kind: 'approval',
      optionId: 'allow',
      fence: 7,
      commit: async () => {},
      settleOptions
    })
    await expect(answered.promise).resolves.toMatchObject({ behavior: 'allow' })
    await tick()

    await vi.waitFor(() => expect(settleOptions).toHaveBeenCalledWith({}))
    expect(permissionMode).toBe('acceptEdits')
  })

  it('reports and publishes a failed approved plan exit without failing the prompt answer', async () => {
    let permissionMode = 'acceptEdits'
    const claude = fakeClaude({
      initPermissionMode: 'acceptEdits',
      routes: {
        get_settings: () => ({ applied: { permissionMode } }),
        set_permission_mode: (params) => {
          const next = String(params?.mode)
          if (next === 'acceptEdits') {
            throw new Error('restore failed')
          }
          permissionMode = next
        }
      }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({
      sessionId: 'session-1',
      key: 'permissionMode',
      value: 'plan',
      fence: 7
    })
    const answered = invokeCanUseTool(
      claude.connections[0],
      'ExitPlanMode',
      'exit-plan-failed',
      'tool-failed'
    )
    adapter.bindPromptItemId('session-1', 'journal-failed', 'exit-plan-failed')
    const settleOptions = vi.fn(async () => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-failed',
      kind: 'approval',
      optionId: 'allow',
      fence: 7,
      commit: async () => {},
      settleOptions
    })
    await expect(answered.promise).resolves.toMatchObject({ behavior: 'allow' })
    await tick()

    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce())
    expect(settleOptions).toHaveBeenCalledWith({ permissionMode: 'acceptEdits' })
    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options).toMatchObject({
      current: { permissionMode: 'plan', confirmed: expect.arrayContaining(['permissionMode']) }
    })
    const projected = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('claude'),
      CLAUDE_SESSION_OPTION_CATALOG,
      options
    )
    expect(
      structuredAgentSessionOptionSnapshot(projected).find(({ id }) => id === 'permissionMode')
    ).toMatchObject({ valueSource: 'reported', kind: { currentValue: 'plan' } })
    expect(permissionMode).toBe('plan')
    warning.mockRestore()
  })

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
