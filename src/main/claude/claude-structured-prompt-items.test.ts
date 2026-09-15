import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { encodeAgentSessionQuestionAnswers } from '../../shared/agent-session-question-answer'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from '../native-chat/agent-session-journal/journal-row-schema'
import { MAX_TOOL_DETAIL_LENGTH } from '../../shared/native-chat-tool-summary'
import { claudeApprovalItem, claudeQuestionItems } from './claude-structured-prompt-items'
import {
  applyClaudePromptAnswer,
  encodeClaudeQuestionOptionId,
  type ClaudePendingPrompt
} from './claude-structured-prompt-replies'

function approvalPrompt(
  input: Record<string, unknown>,
  presentation: Partial<ClaudePendingPrompt> = {}
): ClaudePendingPrompt {
  return {
    requestId: 'approval-1',
    promptKey: 'approval-1',
    toolUseId: 'tool-approval',
    toolName: 'ExitPlanMode',
    kind: 'approval',
    input,
    suggestions: [],
    questionIds: [],
    answers: new Map(),
    settle: () => {},
    ...presentation
  }
}

describe('Claude structured approval presentation', () => {
  it('journals a plan as a typed subject without the generic JSON detail', () => {
    const prompt = approvalPrompt(
      { plan: '# Release\n\n- Run tests', planFilePath: '/repo/plan.md' },
      {
        title: 'Claude wants to present its plan',
        displayName: 'Present plan',
        description: 'Review the implementation plan.',
        decisionReason: 'Plan mode requires approval.',
        blockedPath: '/repo/plan.md',
        matchedAskRule: { source: 'project', toolName: 'ExitPlanMode', ruleContent: 'ask' },
        subject: { kind: 'plan', text: '# Release\n\n- Run tests', filePath: '/repo/plan.md' }
      }
    )

    expect(claudeApprovalItem(prompt)).toMatchObject({
      kind: 'approval',
      title: 'Claude wants to present its plan',
      displayName: 'Present plan',
      description: 'Review the implementation plan.',
      decisionReason: 'Plan mode requires approval.',
      blockedPath: '/repo/plan.md',
      matchedAskRule: { source: 'project', toolName: 'ExitPlanMode', ruleContent: 'ask' },
      subject: { kind: 'plan', text: '# Release\n\n- Run tests', filePath: '/repo/plan.md' },
      detail: null,
      options: [
        { id: 'allow', label: 'Approve plan' },
        { id: 'allowForSession', label: 'Approve plan for this session' },
        { id: 'deny', label: 'Keep planning' },
        { id: 'cancel', label: 'Stop' }
      ]
    })
  })

  it.each([{ plan: '' }, {}])('degrades an empty plan to a visible generic detail', (input) => {
    const item = claudeApprovalItem(approvalPrompt(input))

    expect(item.title).toBe('Allow ExitPlanMode?')
    expect(item.subject).toBeUndefined()
    expect(item.detail).toContain('{')
    expect(item.options[0]?.label).toBe('Allow')
  })

  it('caps an oversized generic payload with the shared tool-detail limit', () => {
    const item = claudeApprovalItem(
      approvalPrompt({ plan: '', payload: 'x'.repeat(MAX_TOOL_DETAIL_LENGTH * 2) })
    )

    expect(item.detail?.length).toBeLessThanOrEqual(MAX_TOOL_DETAIL_LENGTH + 1)
    expect(item.detail?.endsWith('…')).toBe(true)
  })

  it('denying a plan authorizes nothing', () => {
    const prompt = approvalPrompt(
      { plan: '# Release' },
      { subject: { kind: 'plan', text: '# Release' } }
    )

    expect(applyClaudePromptAnswer({ prompt }, 'deny')).toEqual({
      behavior: 'deny',
      message: 'User denied this action.',
      toolUseID: 'tool-approval'
    })
  })
})

describe('Claude structured question addressing', () => {
  it('bounds a valid grouped question before cancellation enters a lifecycle batch', () => {
    const oversized = 'large prompt text '.repeat(40_000)
    const questions = Array.from({ length: 4 }, (_, questionIndex) => ({
      question: `${questionIndex}:${oversized}`,
      header: oversized,
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        label: `${optionIndex}:${oversized}`,
        description: oversized
      }))
    }))
    const prompt: ClaudePendingPrompt = {
      requestId: 'oversized-question',
      promptKey: 'oversized-question',
      toolUseId: 'tool-oversized',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: { questions },
      suggestions: [],
      questionIds: questions.map((question) => question.question),
      answers: new Map(),
      settle: () => {}
    }

    const body = claudeQuestionItems({ sessionId: 'session-1', prompt })[0]?.body
    if (!body) {
      throw new Error('expected grouped question body')
    }
    const cancelled = cancelledJournalPromptBody(body)
    if (!cancelled) {
      throw new Error('expected cancellable grouped question body')
    }

    expect(body.questions).toHaveLength(4)
    expect(body.questions?.[0]?.question).toContain('[Orca: output truncated')
    expect(body.questions?.[0]?.options[0]?.description).toContain('[Orca: output truncated')
    expect(Buffer.byteLength(JSON.stringify(cancelled), 'utf8') + 4_096).toBeLessThan(
      MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
    )
  })

  it('keeps wire IDs bounded while returning the original question and choice', () => {
    const questionId = 'Which option? '.repeat(100)
    const label = 'A detailed choice '.repeat(100)
    const prompt: ClaudePendingPrompt = {
      requestId: 'question-1',
      promptKey: 'question-1',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: { questions: [{ question: questionId, options: [{ label }] }] },
      suggestions: [],
      questionIds: [questionId],
      answers: new Map(),
      settle: () => {}
    }

    const item = claudeQuestionItems({ sessionId: 'session-1', prompt })[0]!
    expect(agentJournalItemKey(item.identity).length).toBeLessThan(512)
    expect(item.body.options[0]!.id.length).toBeLessThan(512)
    expect(item.body.freeTextQuestionId).toBe('q1')
    expect(applyClaudePromptAnswer({ prompt }, item.body.options[0]!.id)).toMatchObject({
      updatedInput: { answers: { [questionId]: label } }
    })
  })

  it('preserves colon-containing free-text answers', () => {
    const questionId = 'Where should this run?'
    const prompt: ClaudePendingPrompt = {
      requestId: 'question-1',
      promptKey: 'question-1',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: { questions: [{ question: questionId }] },
      suggestions: [],
      questionIds: [questionId],
      answers: new Map(),
      settle: () => {}
    }
    const answer = 'https://example.test:8443/path'

    expect(
      applyClaudePromptAnswer({ prompt }, encodeClaudeQuestionOptionId('q1', answer))
    ).toMatchObject({
      updatedInput: { answers: { [questionId]: answer } }
    })
  })

  it('returns arrays for multi-select and preserves mixed single and Other answers', () => {
    const multiQuestion = 'Which targets?'
    const singleQuestion = 'Which mode?'
    const otherQuestion = 'Where should it run?'
    const prompt: ClaudePendingPrompt = {
      requestId: 'question-1',
      promptKey: 'question-1',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: {
        questions: [
          {
            question: multiQuestion,
            multiSelect: true,
            options: [{ label: 'frontend' }, { label: 'backend' }]
          },
          {
            question: singleQuestion,
            options: [{ label: 'fast' }, { label: 'safe' }]
          },
          { question: otherQuestion, options: [] }
        ]
      },
      suggestions: [],
      questionIds: [multiQuestion, singleQuestion, otherQuestion],
      answers: new Map(),
      settle: () => {}
    }
    const item = claudeQuestionItems({ sessionId: 'session-1', prompt })[0]!
    const questions = item.body.questions!
    const encoded = encodeAgentSessionQuestionAnswers([
      {
        questionId: 'q1',
        optionIds: [questions[0]!.options[0]!.id, questions[0]!.options[1]!.id]
      },
      { questionId: 'q2', optionIds: [questions[1]!.options[1]!.id] },
      { questionId: 'q3', optionIds: [], other: 'remote host' }
    ])

    expect(applyClaudePromptAnswer({ prompt }, encoded)).toMatchObject({
      updatedInput: {
        answers: {
          [multiQuestion]: ['frontend', 'backend'],
          [singleQuestion]: 'safe',
          [otherQuestion]: 'remote host'
        }
      }
    })
  })
})
