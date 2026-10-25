import { describe, expect, it } from 'vitest'
import {
  projectStructuredQuestion,
  type StructuredQuestionItem
} from './mobile-structured-agent-prompts'

/** The shape the host emits for a Claude AskUserQuestion carrying more than one question:
 *  the flat `question`/`options` pair is a placeholder and the real content is in `questions`. */
function groupedPrompt(): StructuredQuestionItem {
  return {
    itemId: 'item-1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Which database?',
          multiSelect: false,
          options: [{ id: 'q1:choice-1', label: 'Postgres', description: 'Durable server' }],
          freeTextQuestionId: 'q1'
        },
        {
          id: 'q2',
          question: 'Which regions?',
          multiSelect: true,
          options: [{ id: 'q2:choice-1', label: 'us-east' }],
          freeTextQuestionId: 'q2'
        }
      ],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

describe('structured question projection for grouped Claude prompts', () => {
  it('renders an answerable question instead of the empty placeholder card', () => {
    const projected = projectStructuredQuestion(groupedPrompt())

    expect(projected?.question).toBe('Which database? (1 of 2)')
    expect(projected?.options).toEqual(['Postgres'])
    expect(projected?.optionDescriptions).toEqual(['Durable server'])
    expect(projected?.optionTokens.filter(Boolean)).toHaveLength(1)
  })
})
