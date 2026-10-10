import { describe, expect, it, vi } from 'vitest'
import { AgentSessionPromptAnswerRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import { acquired, fakeClaude, tick } from './claude-structured-session-test-support'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'

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
    // The answer resolves the SDK's own callback promise; the SDK writes the wire response.
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
    // A cancelled request is forgotten and settled with null — never an authorization.
    await expect(answered.promise).resolves.toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'prompt-cancelled', promptKey: 'permission-9' })
    // A late answer after the abort must not authorize the wrong tool.
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
