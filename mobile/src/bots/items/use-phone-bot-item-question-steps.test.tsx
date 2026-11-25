import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import type { BotItemQuestionStepsSend } from '../../../../src/shared/bots/use-bot-item-question-steps'
import { useBotItemQuestionSteps } from './use-phone-bot-item-question-steps'

const asked = (id: string, prompt: string): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' },
  data: {
    text: prompt,
    ask: { questions: [{ prompt, options: [{ label: 'Yes' }, { label: 'No' }] }] }
  },
  at: 1
})

// The agent asked A, then replaced it with B; the host's read names B.
const item = makeTestBotItem(1, { status: 'needs_you', waitingAsk: 'e2' })
const events = [asked('e1', 'Merge A?'), asked('e2', 'Merge B?')]

let tree: ReactTestRenderer | null = null
afterEach(() => {
  const shown = tree
  tree = null
  if (shown) {
    act(() => shown.unmount())
  }
})

function quickReplies(send: BotItemQuestionStepsSend) {
  let quick: ReturnType<typeof useBotItemQuestionSteps>['quick'] | null = null
  function Steps() {
    quick = useBotItemQuestionSteps('host\0bot\0uid-1', item, events, send, []).quick
    return null
  }
  act(() => {
    tree = create(createElement(Steps))
  })
  return quick!
}

it('keeps a card answer to a replaced ask on that ask, so the host refuses it', () => {
  const send = vi.fn<BotItemQuestionStepsSend>()
  // A's card sends late (its pick timer, say), after the read already names B.
  const quick = quickReplies(send)
  act(() => quick('Yes', { askId: 'e1', skipped: [] }))
  expect(send).toHaveBeenCalledTimes(1)
  const [text, , questionId, , , , intent] = send.mock.calls[0]!
  expect(text).toBe('Yes')
  expect(questionId).toBe('e1')
  // No intent for B: a refusal gives the words back as typed.
  expect(intent).toBeUndefined()
})

it('binds a card answer to the ask it shows', () => {
  const send = vi.fn<BotItemQuestionStepsSend>()
  const quick = quickReplies(send)
  act(() => quick('Yes', { askId: 'e2', skipped: [] }))
  const [, , questionId, , , , intent] = send.mock.calls[0]!
  expect(questionId).toBe('e2')
  expect(intent).toMatchObject({ askId: 'e2', answers: ['Yes'] })
})
