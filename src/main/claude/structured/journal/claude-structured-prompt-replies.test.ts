import { describe, expect, it } from 'vitest'
import { isValidAgentSessionQuestionAnswers } from '../../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { structuredQuestionAnswers } from '../../../../shared/native-chat/input/questions/structured-agent-question-card'
import { ClaudePromptRegistry } from '../permissions/claude-prompt-registry'
import { claudeQuestionItems } from './claude-structured-prompt-items'
import { buildClaudePromptReply } from './claude-structured-prompt-replies'

function askUserQuestion() {
  const prompt = new ClaudePromptRegistry().register({
    requestId: 'request-1',
    toolName: 'AskUserQuestion',
    toolUseId: 'tool-1',
    input: {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }]
        },
        {
          question: 'Which features?',
          header: 'Features',
          multiSelect: true,
          options: [{ label: 'Auth' }, { label: 'Billing' }]
        },
        {
          question: 'Which region?',
          header: 'Region',
          multiSelect: false,
          options: [{ label: 'US' }, { label: 'EU' }]
        }
      ]
    },
    suggestions: [],
    settle: () => {}
  })
  if (!prompt) {
    throw new Error('expected a Claude question prompt')
  }
  const [item] = claudeQuestionItems({ sessionId: 'session-1', prompt })
  return { prompt, questions: item!.body.questions! }
}

describe('Claude question replies', () => {
  it('submits a partly answered set, leaving skipped questions out as Claude does', () => {
    const { prompt, questions } = askUserQuestion()
    // The card's selections: database answered, features skipped, region typed.
    const answers = structuredQuestionAnswers(questions, [
      { indices: [1], other: '' },
      { indices: [], other: '' },
      { indices: [], other: 'Asia' }
    ])

    expect(answers).not.toBeNull()
    expect(isValidAgentSessionQuestionAnswers(questions, answers!)).toBe(true)
    expect(buildClaudePromptReply(prompt, { kind: 'answers', answers: answers! })).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...prompt.input,
        answers: { 'Which database?': 'SQLite', 'Which region?': 'Asia' }
      },
      toolUseID: 'tool-1'
    })
  })

  it('refuses a set with nothing answered', () => {
    const { prompt, questions } = askUserQuestion()
    const skipped = questions.map((question) => ({ questionId: question.id, optionIds: [] }))

    expect(structuredQuestionAnswers(questions, [])).toBeNull()
    expect(isValidAgentSessionQuestionAnswers(questions, skipped)).toBe(false)
    expect(() => buildClaudePromptReply(prompt, { kind: 'answers', answers: skipped })).toThrow(
      /leaves every question/
    )
  })
})
