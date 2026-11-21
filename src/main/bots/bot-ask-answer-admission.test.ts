import { expect, it } from 'vitest'
import { ClaudePromptRegistry } from '../claude/structured/permissions/claude-prompt-registry'
import { claudeQuestionItems } from '../claude/structured/journal/claude-structured-prompt-items'
import { buildClaudePromptReply } from '../claude/structured/journal/claude-structured-prompt-replies'
import { CodexPromptRegistry } from '../codex/structured/prompts/codex-prompt-registry'
import { codexQuestionItems } from '../codex/structured/prompts/codex-structured-prompt-items'
import { prepareCodexPromptAnswer } from '../codex/structured/prompts/codex-structured-prompt-replies'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers
} from '../../shared/agent-session/requests/prompts/agent-session-question-answer'

const cases = [
  {
    name: 'selection with whitespace',
    selected: true,
    other: '  \n',
    valid: true,
    words: 'Today — Keep it until tomorrow.'
  },
  {
    name: 'selection with empty text',
    selected: true,
    other: '',
    valid: true,
    words: 'Today — Keep it until tomorrow.'
  },
  { name: 'whitespace without selection', selected: false, other: '  \n', valid: false },
  { name: 'empty text without selection', selected: false, other: '', valid: false },
  {
    name: 'verbatim text without selection',
    selected: false,
    other: '  Wait for me.\n',
    valid: true,
    words: '  Wait for me.\n'
  },
  { name: 'real text with selection', selected: true, other: '  Wait for me.\n', valid: false }
]

it.each(cases)(
  'keeps Claude admission and relay aligned for $name',
  ({ selected, other, valid, words }) => {
    const prompt = new ClaudePromptRegistry().register({
      requestId: 'ask',
      toolUseId: 'tool',
      toolName: 'AskUserQuestion',
      suggestions: [],
      settle: () => {},
      input: {
        questions: [
          {
            question: 'When?',
            options: [{ label: 'Today', description: 'Keep it until tomorrow.' }]
          }
        ]
      }
    })
    if (!prompt) {
      throw new Error('Request was not registered')
    }
    const body = claudeQuestionItems({ sessionId: 'chat', prompt })[0]?.body
    if (!body) {
      throw new Error('Question was not displayed')
    }
    const answers = [{ questionId: 'q1', optionIds: selected ? ['q1:choice-1'] : [], other }]
    expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(body), answers)).toBe(
      valid
    )
    if (valid) {
      expect(buildClaudePromptReply(prompt, { kind: 'answers', answers })).toMatchObject({
        updatedInput: { answers: { 'When?': words } }
      })
    }
  }
)

it.each(['  \n', ''])(
  'does not add an empty optional text entry to a Claude multi-selection (%j)',
  (other) => {
    const prompt = new ClaudePromptRegistry().register({
      requestId: 'ask',
      toolUseId: 'tool',
      toolName: 'AskUserQuestion',
      suggestions: [],
      settle: () => {},
      input: {
        questions: [
          {
            question: 'When?',
            multiSelect: true,
            options: [{ label: 'Today', description: 'Keep it until tomorrow.' }]
          }
        ]
      }
    })
    if (!prompt) {
      throw new Error('Request was not registered')
    }
    const body = claudeQuestionItems({ sessionId: 'chat', prompt })[0]?.body
    if (!body) {
      throw new Error('Question was not displayed')
    }
    const answers = [{ questionId: 'q1', optionIds: ['q1:choice-1'], other }]
    expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(body), answers)).toBe(
      true
    )
    expect(buildClaudePromptReply(prompt, { kind: 'answers', answers })).toMatchObject({
      updatedInput: { answers: { 'When?': ['Today — Keep it until tomorrow.'] } }
    })
    const withText = [{ questionId: 'q1', optionIds: ['q1:choice-1'], other: '  Wait for me.\n' }]
    expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(body), withText)).toBe(
      true
    )
    expect(buildClaudePromptReply(prompt, { kind: 'answers', answers: withText })).toMatchObject({
      updatedInput: {
        answers: { 'When?': ['Today — Keep it until tomorrow.', '  Wait for me.\n'] }
      }
    })
  }
)

it.each(cases)(
  'keeps Codex admission and relay aligned for $name',
  ({ selected, other, valid, words }) => {
    const params = {
      itemId: 'tool',
      threadId: 'thread',
      questions: [
        {
          id: 'when',
          question: 'When?',
          options: [
            { label: 'Today', description: 'Keep it until tomorrow.' },
            { label: 'Other', isOther: true }
          ]
        }
      ]
    }
    const prompt = new CodexPromptRegistry().register({
      id: 1,
      method: 'item/tool/requestUserInput',
      params
    })
    if (!prompt) {
      throw new Error('Request was not registered')
    }
    const body = codexQuestionItems({ threadId: 'thread', promptKey: prompt.promptKey, params })[0]
      ?.body
    if (!body) {
      throw new Error('Question was not displayed')
    }
    const answers = [{ questionId: 'when', optionIds: selected ? ['when:Today'] : [], other }]
    expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(body), answers)).toBe(
      valid
    )
    if (valid) {
      expect(prepareCodexPromptAnswer(prompt, { kind: 'answers', answers })).toEqual({
        kind: 'answer',
        questionId: 'when',
        answer: words
      })
    }
  }
)
