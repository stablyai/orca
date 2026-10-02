import { describe, expect, it } from 'vitest'
import { parseClaudeQuestions } from './claude-message'

describe('provider user input', () => {
  it('preserves Claude question details', () => {
    expect(
      parseClaudeQuestions([
        {
          header: 'Features',
          question: 'Which features?',
          multiSelect: true,
          options: [{ label: 'Rooms', description: 'Enable rooms' }]
        }
      ])
    ).toEqual([
      {
        id: 'Which features?',
        header: 'Features',
        question: 'Which features?',
        options: [{ label: 'Rooms', description: 'Enable rooms' }],
        allowOther: true,
        multiSelect: true
      }
    ])
  })
})
