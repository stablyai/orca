import { expect, it } from 'vitest'
import { createBotItemPendingCommentsHook } from '../../../../src/shared/bots/bot-item-pending-comments'
import type { BotItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import {
  botItemReplyTargetKey,
  sessionBotItemReplyTargets
} from '../../../../src/shared/bots/bot-item-reply-target'
import { botItemCommentDrafts } from './bot-item-comment-drafts'
import { phoneBotItemReturnText } from './phone-bot-item-refused-reply'

// The shared store, called outside React: one render's reads, as the page's hook gets them.
const pendingCommentsOutsideReact = createBotItemPendingCommentsHook({
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, read) => read()
})

const one: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: 'Merge it?',
      replies: [
        { label: 'Yes', recommended: false },
        { label: 'No', recommended: false }
      ]
    }
  ]
}
const two: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: 'Use these hostnames?',
      replies: [
        { label: 'Yes', recommended: false },
        { label: 'No', recommended: false }
      ]
    },
    {
      question: 'Go ahead?',
      replies: [
        { label: 'Yes', recommended: false },
        { label: 'No', recommended: false }
      ]
    }
  ]
}

// The answer card's reply to an ask the agent has since replaced: the host refuses it.
async function refusedCardAnswer(
  key: string,
  text: string,
  intent?: { askId: string; shape: BotItemQuestionShape; answers: (string | null)[] }
): Promise<string | undefined> {
  const pending = pendingCommentsOutsideReact(key, [], {
    post: () => Promise.reject(Object.assign(new Error('new question'), { code: 'item_changed' })),
    failed: () => {},
    returnText: phoneBotItemReturnText(key, key),
    refresh: () => {},
    requestIds: true,
    questionIds: true,
    plain: true
  })
  pending.send(text, [], null, 'e2', false, [], [], intent)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return botItemCommentDrafts.get(key)
}

it('keeps a card answer refused for a replaced question in the comment box', async () => {
  expect(await refusedCardAnswer('one', 'Yes', { askId: 'e2', shape: one, answers: ['Yes'] })).toBe(
    'Yes'
  )
  expect(
    await refusedCardAnswer('two', 'Use these hostnames? → Yes\nGo ahead? → No', {
      askId: 'e2',
      shape: two,
      answers: ['Yes', 'No']
    })
  ).toBe('Yes\nNo')
  // A pending reply from before `intent` still gives its words back.
  expect(await refusedCardAnswer('old', 'Yes')).toBe('Yes')
})

it('puts a refused answer after words typed in the box since', async () => {
  botItemCommentDrafts.set('typed', 'also check staging')
  expect(
    await refusedCardAnswer('typed', 'Yes', { askId: 'e2', shape: one, answers: ['Yes'] })
  ).toBe('also check staging\nYes')
})

it('keeps a short refused answer that typed words only contain inside a line', async () => {
  botItemCommentDrafts.set('inside', 'Not yet')
  expect(
    await refusedCardAnswer('inside', 'No', { askId: 'e2', shape: one, answers: ['No'] })
  ).toBe('Not yet\nNo')
})

it('a refused reply put back in an empty box answers no question', async () => {
  const key = 'host\0agent\0put-back'
  await refusedCardAnswer(key, 'Yes')
  expect(botItemCommentDrafts.get(key)).toBe('Yes')
  expect(JSON.parse(sessionBotItemReplyTargets.read(botItemReplyTargetKey(key))).bound).toBe('none')
})
