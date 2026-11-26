import { afterEach, expect, it } from 'vitest'
import { botItemPickedReplies, botItemQuestionShape } from '../../shared/bots/bot-item-ask'
import {
  RECOMMENDED_ASKS,
  RECOMMENDED_ASK_ANSWERS
} from '../../shared/bots/bot-item-ask-recommended.test-fixture'
import type { BotItemAsk } from '../../shared/bots/bot-item-ask'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import {
  BOT_ITEM_EVENT_KINDS,
  botItemEventId,
  type BotItemEvent
} from '../../shared/bots/bot-items'
import { botItemQuestionPairing } from '../../shared/bots/bot-item-question-answers'
import { botItemChangeMail } from './bot-items-mail-text'
import { BotItemsStore } from './bot-items-store'

const NOW = 1_800_000_000_000
const AGENT: BotItemBotActor = { kind: 'bot', botId: 'agent', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

/** An item whose agent asks `ask` the way `bot item set --status needs-you --ask` does, read back fresh. */
function asked(ask: BotItemAsk) {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  const { uid } = store.add(
    {
      ownerBotId: AGENT.botId,
      chatId: AGENT.chatId,
      source: { kind: 'home', title: null },
      title: 'Ship it',
      status: 'working',
      links: []
    },
    AGENT,
    NOW
  )
  store.set(uid, { status: 'needs_you', ask }, AGENT, NOW)
  const questionEvent = store.get(uid)!.questionEvent!
  const event = store.events(uid, 0, 200).find((at) => at.id === questionEvent)!
  const answer = (text: string) => {
    store.ownerComment(uid, text, OWNER, [], NOW, undefined, questionEvent)
    const reply = store.events(uid, 0, 200).findLast((at) => at.kind === 'commented')!
    return {
      reply,
      mail: botItemChangeMail([{ event: reply, item: store.get(uid)! }])?.body ?? ''
    }
  }
  return {
    data: event.data,
    shape: botItemQuestionShape(event.data),
    answer,
    store,
    uid,
    questionEvent
  }
}

it.each(Object.entries(RECOMMENDED_ASKS))(
  'stores the %s ask with its recommendation in the flag, as the renderers expect',
  (_, { written, stored }) => {
    const { data, shape } = asked(written)
    expect(data.ask).toEqual(stored)
    // The text for readers without the ask notes each flag once, and only the flag.
    const questions: BotItemAsk['questions'] = stored.questions
    const flagged = questions.filter((question) => question.recommended !== undefined)
    expect(String(data.text).match(/ \(recommended\)/g) ?? []).toHaveLength(flagged.length)
    expect(
      shape.decisions.flatMap((decision) => decision.replies.filter((reply) => reply.recommended))
    ).toHaveLength(flagged.length)
  }
)

// The answers are what the desktop browser check and the phone card test assert each surface posts.
const fenced = (mail: string, words: string) =>
  expect(mail).toContain(`answered your question e2 (event e4):\n<<<\n${words}\n>>>`)

it.each([
  ['written', RECOMMENDED_ASK_ANSWERS.written, [['Waive; ship it disclosed']]],
  ['flagged', RECOMMENDED_ASK_ANSWERS.flagged, [['Wait for Monday']]],
  ['twin', RECOMMENDED_ASK_ANSWERS.twin, [['Go (Recommended)']]],
  ['several', RECOMMENDED_ASK_ANSWERS.several, [['Ship it'], ['No']]]
] as const)(
  'reads the %s answer back as the choice it posted, in the owner mail too',
  (name, words, picks) => {
    const { shape, answer } = asked(RECOMMENDED_ASKS[name].written)
    const { reply, mail } = answer(words)
    expect(reply.data.answers).toBeDefined()
    expect(reply.data.text).toBe(words)
    expect(
      botItemPickedReplies(shape, reply.data).map((line) => line.map((pick) => pick.label))
    ).toEqual(picks)
    fenced(mail, words)
  }
)

it('keeps two pick-several answers apart when a label reads like two picks', () => {
  const both = asked(RECOMMENDED_ASKS.joined.written)
  const two = both.answer(RECOMMENDED_ASK_ANSWERS.joinedTwo)
  const bundled = asked(RECOMMENDED_ASKS.joined.written).answer(
    RECOMMENDED_ASK_ANSWERS.joinedBundled
  )
  expect(two.reply.data.text).not.toBe(bundled.reply.data.text)
  const labels = (data: Record<string, unknown>) =>
    botItemPickedReplies(both.shape, data)[0]!.map((pick) => pick.label)
  expect(labels(two.reply.data)).toEqual(['Audit', 'Notify'])
  expect(labels(bundled.reply.data)).toEqual(['Audit, Notify (Recommended)'])
  fenced(two.mail, RECOMMENDED_ASK_ANSWERS.joinedTwo)
  fenced(bundled.mail, RECOMMENDED_ASK_ANSWERS.joinedBundled)
})

// Two choices that were told apart before cleaning are still told apart: each posted on its own fresh
// ask, as its surface sends it, then read back from the owner event and the owner mail.
type Choice = { words: string; picks: string[] }
const pairs: [keyof typeof RECOMMENDED_ASKS, Choice, Choice][] = [
  [
    'delimited',
    { words: RECOMMENDED_ASK_ANSWERS.delimitedOne, picks: ['Audit, (Recommended)'] },
    {
      words: RECOMMENDED_ASK_ANSWERS.delimitedPair,
      picks: ['Audit [recommended]', '(Recommended)']
    }
  ],
  [
    'delimitedReordered',
    { words: RECOMMENDED_ASK_ANSWERS.delimitedReorderedOne, picks: ['Audit, (Recommended)'] },
    {
      words: RECOMMENDED_ASK_ANSWERS.delimitedReorderedPair,
      picks: ['(Recommended)', 'Audit [recommended]']
    }
  ],
  [
    'twinFlagged',
    { words: RECOMMENDED_ASK_ANSWERS.twinFlaggedPlain, picks: ['Go'] },
    { words: RECOMMENDED_ASK_ANSWERS.twinFlaggedMarked, picks: ['Go (Recommended)'] }
  ],
  [
    'bracketAttached',
    { words: RECOMMENDED_ASK_ANSWERS.bracketAttachedClean, picks: ['Go'] },
    { words: RECOMMENDED_ASK_ANSWERS.bracketAttachedLiteral, picks: ['Go(Recommended)'] }
  ],
  [
    'commaWait',
    { words: RECOMMENDED_ASK_ANSWERS.commaWaitLiteral, picks: ['A, (Recommended)'] },
    { words: RECOMMENDED_ASK_ANSWERS.commaWaitFlag, picks: ['Wait'] }
  ],
  [
    'subsets',
    { words: RECOMMENDED_ASK_ANSWERS.subsetsFirst, picks: ['A, B (Recommended)', 'C'] },
    { words: RECOMMENDED_ASK_ANSWERS.subsetsSecond, picks: ['A', 'B, C'] }
  ],
  [
    'subsetsReordered',
    { words: RECOMMENDED_ASK_ANSWERS.subsetsReorderedFirst, picks: ['B, C', 'A'] },
    { words: RECOMMENDED_ASK_ANSWERS.subsetsReorderedSecond, picks: ['C', 'A, B (Recommended)'] }
  ]
]
it.each(pairs)('keeps the %s choices apart from the post to the owner mail', (name, ...choices) => {
  const read = choices.map(({ words, picks }) => {
    const { shape, answer } = asked(RECOMMENDED_ASKS[name].written)
    const { reply, mail } = answer(words)
    expect(reply.data.text).toBe(words)
    expect(botItemPickedReplies(shape, reply.data)[0]!.map((pick) => pick.label)).toEqual(picks)
    fenced(mail, words)
    return reply.data.text
  })
  expect(new Set(read).size).toBe(2)
})

it('posts a label kept for its attached mark as written', () => {
  const { shape, answer } = asked(RECOMMENDED_ASKS.attached.written)
  const { reply, mail } = answer(RECOMMENDED_ASK_ANSWERS.attached)
  expect(botItemPickedReplies(shape, reply.data)[0]!.map((pick) => pick.label)).toEqual([
    'Go(Recommended) [recommended]'
  ])
  fenced(mail, RECOMMENDED_ASK_ANSWERS.attached)
})

it('keeps the folded several-question answers apart, the pair read back as its picks', () => {
  const pair = asked(RECOMMENDED_ASKS.severalFolded.written)
  const two = pair.answer(RECOMMENDED_ASK_ANSWERS.severalFoldedPair)
  const one = asked(RECOMMENDED_ASKS.severalFolded.written).answer(
    RECOMMENDED_ASK_ANSWERS.severalFoldedOne
  )
  expect(two.reply.data.text).not.toBe(one.reply.data.text)
  const picks = (data: Record<string, unknown>) =>
    botItemPickedReplies(pair.shape, data).map((line) => line.map((at) => at.label))
  expect(picks(two.reply.data)).toEqual([['Audit', 'Notify'], ['Yes']])
  // The spaced label's folded words are not read as the two picks (the decoder's own limit with
  // folded spacing is as before this change).
  expect(picks(one.reply.data)[0]).not.toEqual(['Audit', 'Notify'])
  fenced(two.mail, RECOMMENDED_ASK_ANSWERS.severalFoldedPair)
  fenced(one.mail, RECOMMENDED_ASK_ANSWERS.severalFoldedOne)
})

it('pairs a stepped answer with both questions when a label of several lines reads like it', () => {
  const { store, uid, questionEvent, answer } = asked(RECOMMENDED_ASKS.multiline.written)
  const askId = botItemEventId(questionEvent)
  // The item's view reads which ask waits, as an open item does, before the answer comes.
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(askId)
  const { reply } = answer(RECOMMENDED_ASK_ANSWERS.multilineStepped)
  const events = store
    .events(uid, 0, 200)
    .map(({ id, kind, actor, data, createdAt }): BotItemEvent => ({
      id: botItemEventId(id),
      kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
      actor,
      data,
      at: createdAt
    }))
  const pairing = botItemQuestionPairing({ status: store.get(uid)!.status }, events)
  const entry = pairing.questions.get(askId)
  // Each question's answer is the comment just committed, and nothing is left waiting.
  expect(entry?.answers.map((at) => at?.id ?? null)).toEqual([
    botItemEventId(reply.id),
    botItemEventId(reply.id)
  ])
  expect(entry?.waiting).toBe(false)
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
})
