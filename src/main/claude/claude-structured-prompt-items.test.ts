import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { encodeAgentSessionQuestionAnswers } from '../../shared/agent-session-question-answer'
import { claudeQuestionItems } from './claude-structured-prompt-items'
import {
  applyClaudePromptAnswer,
  encodeClaudeQuestionOptionId,
  type ClaudePendingPrompt
} from './claude-structured-prompt-replies'

describe('Claude structured question addressing', () => {
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
