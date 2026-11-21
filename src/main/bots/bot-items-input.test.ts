import { expect, it } from 'vitest'
import { botItemCommentData } from './bot-items-input'

it('keeps the recommendation in the flag, not in the stored label or twice in the text', () => {
  const data = botItemCommentData(undefined, {
    questions: [
      {
        prompt: 'Waive the old warning?',
        options: [{ label: 'Waive; ship it disclosed (Recommended)' }, { label: 'Fix it first' }]
      }
    ]
  })
  expect(data.ask?.questions[0]).toEqual({
    prompt: 'Waive the old warning?',
    options: [{ label: 'Waive; ship it disclosed' }, { label: 'Fix it first' }],
    recommended: 0
  })
  expect(data.text).toBe(
    'Waive the old warning?\n   - Waive; ship it disclosed (recommended)\n   - Fix it first'
  )
})
