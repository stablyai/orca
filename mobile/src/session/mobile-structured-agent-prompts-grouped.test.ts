import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
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
    body: {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Which database?',
          multiSelect: false,
          options: [{ id: 'q1:choice-1', label: 'Postgres' }],
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
      resolution: { state: 'pending' }
    }
  } as unknown as AgentJournalRenderItem as StructuredQuestionItem
}

describe('structured question projection for grouped Claude prompts', () => {
  it('renders an answerable question instead of the empty placeholder card', () => {
    const projected = projectStructuredQuestion(groupedPrompt())

    expect(projected?.question).not.toBe('2 grouped questions from Claude')
    expect(projected?.options).toEqual(['Postgres'])
    expect(projected?.optionTokens.filter(Boolean)).toHaveLength(1)
  })
})
