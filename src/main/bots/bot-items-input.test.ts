import { expect, it } from 'vitest'
import { botItemPickedReplies, botItemQuestionShape } from '../../shared/bots/bot-item-ask'
import { BOT_ITEM_LIMITS } from '../../shared/bots/bot-items'
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

it('stores a flagged and written ask with one mark, read back as the reply it posts', () => {
  const data = botItemCommentData(undefined, {
    questions: [
      {
        prompt: 'Merge without the review?',
        options: [{ label: 'Merge now' }, { label: 'Wait for Monday (Recommended)' }],
        recommended: 1
      }
    ]
  })
  const shape = botItemQuestionShape({ text: data.text, ask: data.ask })
  expect(shape.decisions[0]!.replies).toEqual([
    { label: 'Merge now', recommended: false },
    { label: 'Wait for Monday', recommended: true }
  ])
  expect(data.text).toBe(
    'Merge without the review?\n   - Merge now\n   - Wait for Monday (recommended)'
  )
  expect(botItemPickedReplies(shape, { text: 'Wait for Monday' })).toEqual([
    [{ label: 'Wait for Monday', recommended: true }]
  ])
})

it('takes an ask that fit as written even when a read recommendation would not', () => {
  const ask = (recommended?: number) => ({
    context: 'x'.repeat(BOT_ITEM_LIMITS.text - 45),
    questions: [
      {
        prompt: 'Choose?',
        options: [{ label: 'Close' }, { label: 'Close (Recommended)' }],
        ...(recommended === undefined ? {} : { recommended })
      }
    ]
  })
  const asWritten = botItemCommentData(undefined, ask())
  expect(asWritten.text).toHaveLength(BOT_ITEM_LIMITS.text)
  expect(asWritten.ask?.questions[0]).toEqual(ask().questions[0])
  // A flag on the other option notes it, as it always did; the twin keeps its words.
  const flagged = botItemCommentData(undefined, {
    ...ask(0),
    context: 'x'.repeat(BOT_ITEM_LIMITS.text - 59)
  })
  expect(flagged.text).toHaveLength(BOT_ITEM_LIMITS.text)
  expect(flagged.ask?.questions[0]).toEqual(ask(0).questions[0])
  expect(flagged.text.endsWith('   - Close (recommended)\n   - Close (Recommended)')).toBe(true)
  // Too long as written is still refused.
  expect(() => botItemCommentData(undefined, { ...ask(), context: `${ask().context}xx` })).toThrow(
    /limit/
  )
})
