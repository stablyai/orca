import { expect, it } from 'vitest'
import {
  botItemAskText,
  botItemPickedReplies,
  botItemQuestionShape
} from '../../shared/bots/bot-item-ask'
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

it("takes an exact-limit ask, keeping each question's own recommendation", () => {
  const questions = [
    {
      prompt: 'Merge?',
      options: [{ label: 'Merge now (Recommended)' }, { label: 'Wait' }],
      recommended: 0
    },
    { prompt: 'Choose?', options: [{ label: 'Close' }, { label: 'Close (Recommended)' }] },
    { prompt: 'Notify?', options: [{ label: 'Yes [recommended]' }, { label: 'No' }] }
  ]
  const written = { questions }
  const context = (extra: number) =>
    'x'.repeat(BOT_ITEM_LIMITS.text - botItemAskText(written).length - 2 + extra)
  const data = botItemCommentData(undefined, { context: context(0), questions })
  expect(data.text.length).toBeLessThanOrEqual(BOT_ITEM_LIMITS.text)
  expect(data.ask?.questions).toEqual([
    { prompt: 'Merge?', options: [{ label: 'Merge now' }, { label: 'Wait' }], recommended: 0 },
    // A twin keeps its words and no recommendation is read from them.
    questions[1],
    { prompt: 'Notify?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 0 }
  ])
  // The stored text is what is checked: one cleaned mark's room is taken, and past it is refused.
  expect(botItemCommentData(undefined, { context: context(14), questions }).text).toHaveLength(
    BOT_ITEM_LIMITS.text
  )
  expect(() => botItemCommentData(undefined, { context: context(15), questions })).toThrow(/limit/)
})
