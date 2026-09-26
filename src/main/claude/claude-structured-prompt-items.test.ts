import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from '../native-chat/agent-session-journal/journal-row-schema'
import { MAX_TOOL_DETAIL_LENGTH } from '../../shared/native-chat-tool-summary'
import { claudeApprovalItem, claudeQuestionItems } from './claude-structured-prompt-items'
import {
  buildClaudePromptReply,
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
    settle: () => {},
    ...presentation
  }
}

describe('Claude structured approval presentation', () => {
  it('journals the harness presentation instead of reconstructing from tool input', () => {
    const prompt = approvalPrompt(
      { file_path: '/repo/secrets.txt', content: 'export const token = 1' },
      {
        toolName: 'Write',
        title: 'Claude wants to write secrets.txt',
        displayName: 'Write file',
        description: 'Write access inside the workspace.',
        decisionReason: 'The path requires approval.',
        blockedPath: '/repo/secrets.txt',
        matchedAskRule: { source: 'project', toolName: 'Write', ruleContent: 'ask' }
      }
    )

    expect(claudeApprovalItem(prompt)).toMatchObject({
      kind: 'approval',
      title: 'Claude wants to write secrets.txt',
      displayName: 'Write file',
      description: 'Write access inside the workspace.',
      decisionReason: 'The path requires approval.',
      blockedPath: '/repo/secrets.txt',
      matchedAskRule: { source: 'project', toolName: 'Write', ruleContent: 'ask' },
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'allowForSession', label: 'Allow for this session' },
        { id: 'deny', label: 'Deny' },
        { id: 'cancel', label: 'Stop' }
      ]
    })
  })

  it('journals a plan with typed presentation and readable compatibility detail', () => {
    const prompt = approvalPrompt(
      { plan: '# Release\n\n- Run tests', planFilePath: '/repo/plan.md' },
      {
        title: 'Claude wants to present its plan',
        subject: { kind: 'plan', text: '# Release\n\n- Run tests', filePath: '/repo/plan.md' }
      }
    )

    expect(claudeApprovalItem(prompt)).toMatchObject({
      kind: 'approval',
      title: 'Claude wants to present its plan',
      subject: { kind: 'plan', text: '# Release\n\n- Run tests', filePath: '/repo/plan.md' },
      detail: '# Release\n\n- Run tests',
      options: [
        { id: 'allow', label: 'Approve plan' },
        { id: 'deny', label: 'Keep planning' },
        { id: 'cancel', label: 'Stop' }
      ]
    })
  })

  it('uses a plan-specific fallback title when the harness omits one', () => {
    const item = claudeApprovalItem(
      approvalPrompt({ plan: '# Release' }, { subject: { kind: 'plan', text: '# Release' } })
    )

    expect(item.title).toBe('Review proposed plan')
  })

  it.each([{ plan: '' }, {}])(
    'falls back to a reconstructed title when the harness sends no presentation',
    (input) => {
      const item = claudeApprovalItem(approvalPrompt(input))

      expect(item.title).toBe('Allow ExitPlanMode?')
      expect(item.detail).toContain('{')
      expect(item.options[0]?.label).toBe('Allow')
    }
  )

  it('caps an oversized generic payload with the shared tool-detail limit', () => {
    const item = claudeApprovalItem(
      approvalPrompt({ plan: '', payload: 'x'.repeat(MAX_TOOL_DETAIL_LENGTH * 2) })
    )

    expect(item.detail?.length).toBeLessThanOrEqual(MAX_TOOL_DETAIL_LENGTH + 1)
    expect(item.detail?.endsWith('…')).toBe(true)
  })

  it('keeps generic approval and denial behavior unchanged', () => {
    const prompt = approvalPrompt(
      { command: 'rm output.txt' },
      {
        toolName: 'Bash',
        suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }]
      }
    )

    expect(buildClaudePromptReply(prompt, { kind: 'option', optionId: 'deny' })).toEqual({
      behavior: 'deny',
      message: 'User denied this action.',
      toolUseID: 'tool-approval'
    })
    expect(buildClaudePromptReply(prompt, { kind: 'option', optionId: 'allowForSession' })).toEqual(
      {
        behavior: 'allow',
        updatedInput: { command: 'rm output.txt' },
        updatedPermissions: [
          { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }
        ],
        toolUseID: 'tool-approval'
      }
    )
  })

  it('asks Claude to revise a rejected plan while accepting legacy session replies', () => {
    const prompt = approvalPrompt(
      { plan: '# Release' },
      {
        subject: { kind: 'plan', text: '# Release' },
        suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }]
      }
    )

    expect(buildClaudePromptReply(prompt, { kind: 'option', optionId: 'deny' })).toEqual({
      behavior: 'deny',
      message: 'The user asked you to keep planning. Revise the plan and call ExitPlanMode again.',
      toolUseID: 'tool-approval'
    })
    expect(buildClaudePromptReply(prompt, { kind: 'option', optionId: 'allowForSession' })).toEqual(
      {
        behavior: 'allow',
        updatedInput: { plan: '# Release' },
        toolUseID: 'tool-approval'
      }
    )
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
      settle: () => {}
    }

    const item = claudeQuestionItems({ sessionId: 'session-1', prompt })[0]!
    expect(agentJournalItemKey(item.identity).length).toBeLessThan(512)
    expect(item.body.options[0]!.id.length).toBeLessThan(512)
    expect(item.body.freeTextQuestionId).toBe('q1')
    expect(
      buildClaudePromptReply(prompt, {
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [item.body.options[0]!.id] }]
      })
    ).toMatchObject({
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
      settle: () => {}
    }
    const answer = 'https://example.test:8443/path'

    expect(
      buildClaudePromptReply(prompt, {
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [], other: answer }]
      })
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
      settle: () => {}
    }
    const item = claudeQuestionItems({ sessionId: 'session-1', prompt })[0]!
    const questions = item.body.questions!
    const answers = [
      {
        questionId: 'q1',
        optionIds: [questions[0]!.options[0]!.id, questions[0]!.options[1]!.id]
      },
      { questionId: 'q2', optionIds: [questions[1]!.options[1]!.id] },
      { questionId: 'q3', optionIds: [], other: 'remote host' }
    ]

    expect(buildClaudePromptReply(prompt, { kind: 'answers', answers })).toMatchObject({
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
