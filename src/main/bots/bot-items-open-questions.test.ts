import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import {
  BOT_ITEM_EVENT_KINDS,
  botItemEventId,
  type BotItemEvent
} from '../../shared/bots/bot-items'
import { botItemActivity } from '../../shared/bots/bot-item-activity'
import {
  botItemQuestionPairing,
  botItemWaitingLine
} from '../../shared/bots/bot-item-question-answers'
import { waitingAskChange } from './bot-item-waiting-ask-keep'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const NOW = 1_800_000_000_000
const AGENT: BotItemBotActor = { kind: 'bot', botId: 'agent', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const MERGE = 'Merge it?'

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function item(path = ':memory:') {
  const store = BotItemsStore.open(path)
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
  const ask = (questions: string[]): number => {
    const options = [{ label: 'Yes' }, { label: 'No' }]
    const asked = { questions: questions.map((prompt) => ({ prompt, options })) }
    store.set(uid, { status: 'needs_you', ask: asked }, AGENT, NOW)
    return store.get(uid)!.questionEvent!
  }
  const comment = (text: string, questionEventId?: number) =>
    store.ownerComment(uid, text, OWNER, [], NOW, undefined, questionEventId)
  // What the item's view reads, from the host's item and the events loaded after `after`: the line
  // its comment box replies to, each ask's answers, which ask each reply quotes, and the comments
  // shown waiting.
  const view = (after = 0) => {
    const row = store.get(uid)!
    const waitingAsk = store.viewRows([uid], true).waitingAsks[uid]
    const shown = {
      status: row.status,
      question:
        row.questionEvent === null
          ? null
          : { eventId: botItemEventId(row.questionEvent), text: '' },
      links: [],
      ...(waitingAsk ? { waitingAsk } : {})
    }
    const events = store
      .events(uid, after, 200)
      .map(({ id, kind, actor, data, createdAt }): BotItemEvent => ({
        id: botItemEventId(id),
        kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
        actor,
        data,
        at: createdAt
      }))
    const pairing = botItemQuestionPairing(shown, events)
    return {
      replyingTo: botItemWaitingLine(shown, events),
      asks: pairing.questions,
      quotes: pairing.replies,
      waitingComments: botItemActivity(shown, events).flatMap((entry) =>
        entry.kind === 'comment' && entry.waiting ? [entry.event.id] : []
      )
    }
  }
  const lastComment = () =>
    store.events(uid, 0, 200).findLast((event) => event.kind === 'commented')!
  return { store, uid, ask, comment, view, lastComment }
}

it('offers no reply target for a Needs you comment that asks nothing after the questions were answered', () => {
  const { store, uid, ask, comment, view } = item()
  const asked = ask([HOSTS, GO])
  // The held answers post together.
  comment(`${HOSTS} → Yes\n${GO} → No`, asked)
  expect(store.get(uid)?.status).toBe('working')
  store.set(
    uid,
    { status: 'needs_you', comment: 'Got it. Only the hostname question is left.' },
    AGENT,
    NOW
  )
  expect(view().replyingTo).toBeNull()
})

it('keeps an earlier set of questions answerable after a second set is asked', () => {
  const { ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  const second = ask([MERGE])
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(first), line: HOSTS })

  // The first set's held answers post together, naming their ask while the second is the item's
  // question; the second set is next.
  comment(`${HOSTS} → Yes\n${GO} → No`, first)
  expect(view().asks.get(botItemEventId(first))?.answers.every(Boolean)).toBe(true)
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(second), line: MERGE })

  // A comment box reply to it names no question and still answers it.
  comment('Yes')
  expect(view().asks.get(botItemEventId(second))?.answers.every(Boolean)).toBe(true)
  expect(view().replyingTo).toBeNull()
})

it('shows an open question left by an earlier set after a Needs you comment that asks nothing', () => {
  const { store, uid, ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  // One question answered on its own (an older build, or sent sooner): the item moved on with it.
  comment(`${HOSTS} → Yes`, first)
  const second = ask([MERGE])
  comment('Yes', second)
  store.set(uid, { status: 'needs_you', comment: 'Only one question is left.' }, AGENT, NOW)
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(first), line: GO })
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(first))
})

it('ends every open set when the item is moved by hand after another set was answered', () => {
  const { store, uid, ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  ask([MERGE])
  comment(`${HOSTS} → Yes\n${GO} → No`, first)
  expect(view().replyingTo?.line).toBe(MERGE)
  store.ownerStatus({ uids: [uid], to: 'planned' }, OWNER, NOW)
  expect(view().replyingTo).toBeNull()
})

it('keeps an answer to a question asked again in a later set with the set it was given in', () => {
  const { ask, comment, view, lastComment } = item()
  const first = ask([HOSTS, GO])
  const second = ask([HOSTS, MERGE])
  comment(`${HOSTS} → Yes\n${GO} → No`, first)
  const reply = botItemEventId(lastComment().id)
  const { asks, quotes } = view()
  expect(asks.get(botItemEventId(first))?.answers.every(Boolean)).toBe(true)
  expect(asks.get(botItemEventId(second))?.answers.map(Boolean)).toEqual([false, false])
  expect(quotes.get(reply)?.questionId).toBe(botItemEventId(first))
})

it('records a reply to the set still waiting as its answer once another set moved the item on', () => {
  const { store, uid, ask, comment, lastComment } = item()
  const first = ask([HOSTS, GO])
  const second = ask([MERGE])
  comment(`${HOSTS} → Yes\n${GO} → No`, first)
  expect(store.get(uid)?.status).toBe('working')
  comment('Yes')
  expect(lastComment().data.answers).toBe(botItemEventId(second))
})

// An earlier set left open, a later set answered, then a Needs you comment that asks nothing.
function leftOpen() {
  const made = item()
  const first = made.ask([HOSTS, GO])
  made.comment(`${HOSTS} → Yes`, first)
  // The later set's quick reply, naming its ask.
  const second = made.ask([MERGE])
  made.comment('Yes', second)
  made.store.set(
    made.uid,
    { status: 'needs_you', comment: 'Only one question is left.' },
    AGENT,
    NOW
  )
  return { ...made, first }
}

it('shows only the set still waiting as waiting, not also the comment that asks nothing', () => {
  const { view, first } = leftOpen()
  expect(view().waitingComments).toEqual([botItemEventId(first)])
})

it('waits on no set while the one waiting is still on an earlier page', () => {
  const { ask, view } = item()
  const first = ask([HOSTS, GO])
  ask([MERGE])
  expect(view().replyingTo?.line).toBe(HOSTS)
  // Only the events after the first set are loaded: the later set doesn't stand in for it.
  expect(view(first).replyingTo).toBeNull()
})

it('keeps a reply that names one set out of another set with the same choices', () => {
  const { ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  const second = ask([MERGE])
  // Words that name no question, sent while the first set waits.
  comment('Yes')
  const { asks } = view()
  expect(asks.get(botItemEventId(first))?.answers.map(Boolean)).toEqual([true, false])
  expect(asks.get(botItemEventId(second))?.answers.map(Boolean)).toEqual([false])
})

it('works out the waiting ask from the events when none is kept or an older Orca wrote after it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-items-'))
  try {
    const path = join(dir, 'items.sqlite')
    const { store, uid, ask, comment } = item(path)
    const first = ask([HOSTS, GO])
    comment(`${HOSTS} → Yes`, first)
    ask([MERGE])
    const kept = store.viewRows([uid], true).waitingAsks[uid]
    expect(kept).toBe(botItemEventId(first))
    const file = new DatabaseSync(path)
    file.prepare('DELETE FROM item_waiting_asks').run()
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(kept)
    expect(file.prepare('SELECT ask FROM item_waiting_asks').get()).toEqual({ ask: first })
    // Kept by other pairing rules (another build): not trusted, even when no event came since.
    file.prepare("UPDATE item_waiting_asks SET ask = 0, rules = 'another build'").run()
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(kept)
    // An older Orca's move by hand, which ends every ask, knows nothing of the kept one.
    const moved = file
      .prepare(
        `INSERT INTO item_events (item_uid, kind, actor, data, mail, action, created_at)
         VALUES (?, 'status', '{"kind":"owner"}', '{"from":"needs_you","to":"working"}', NULL, 0, ?)`
      )
      .run(uid, NOW)
    file.prepare('UPDATE items SET last_event_id = ?').run(moved.lastInsertRowid)
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
    file.close()
  } finally {
    stores.splice(0).forEach((store) => store.dispose())
    rmSync(dir, { recursive: true, force: true })
  }
})

it('answers as pairing every event does, reading only the events since the kept ask when they ask nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-items-'))
  try {
    const path = join(dir, 'items.sqlite')
    const { store, uid, ask, comment } = item(path)
    const file = new DatabaseSync(path)
    const keptAt = (): unknown => file.prepare('SELECT at FROM item_waiting_asks').get()?.at
    const lastEvent = (): unknown =>
      file.prepare('SELECT last_event_id FROM items').get()?.last_event_id
    // What an open answers, then what pairing every event answers once nothing is kept.
    const opened = (): [string | undefined, string | undefined] => {
      const kept = store.viewRows([uid], true).waitingAsks[uid]
      file.prepare('DELETE FROM item_waiting_asks').run()
      return [kept, store.viewRows([uid], true).waitingAsks[uid]]
    }
    expect(opened()).toEqual([undefined, undefined])
    const before = keptAt()
    store.comment(uid, 'Still building.', AGENT, [], NOW)
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
    expect(keptAt()).toBe(before)
    expect(opened()).toEqual([undefined, undefined])
    const asked = ask([MERGE])
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(asked))
    expect(keptAt()).toBe(lastEvent())
    expect(opened()).toEqual([botItemEventId(asked), botItemEventId(asked)])
    const waiting = keptAt()
    store.comment(uid, 'Waiting on you.', AGENT, [], NOW)
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(asked))
    expect(keptAt()).toBe(waiting)
    expect(opened()).toEqual([botItemEventId(asked), botItemEventId(asked)])
    comment('Yes', asked)
    expect(opened()).toEqual([undefined, undefined])
    file.close()
  } finally {
    stores.splice(0).forEach((store) => store.dispose())
    rmSync(dir, { recursive: true, force: true })
  }
})

it('passes over only events that pair nothing, and keeps "none" only past events that cannot ask', () => {
  const { store, uid, ask, comment } = item()
  const views = (): BotItemEvent[] =>
    store.events(uid, 0, 200).map(({ id, kind, actor, data, createdAt }) => ({
      id: botItemEventId(id),
      kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
      actor,
      data,
      at: createdAt
    }))
  const waitingOf = (events: readonly BotItemEvent[]): string | undefined =>
    [...botItemQuestionPairing({ status: 'working' }, events).questions].find(
      ([, entry]) => entry.waiting
    )?.[0]
  const event = (
    kind: BotItemEvent['kind'],
    actor: BotItemEvent['actor'],
    data: Record<string, unknown>
  ): BotItemEvent => ({ id: botItemEventId(1_000_000), kind, actor, data, at: NOW })
  const first = ask([HOSTS, GO])
  comment(`${HOSTS} → Yes`, first)
  ask([MERGE])
  const waiting = views()
  expect(waitingOf(waiting)).toBe(botItemEventId(first))
  const ignored = [
    ...BOT_ITEM_EVENT_KINDS.filter((kind) => kind !== 'commented' && kind !== 'status').map(
      (kind) => event(kind, AGENT, {})
    ),
    event('commented', AGENT, { text: 'Still building.' }),
    event('status', AGENT, { from: 'working', to: 'needs_you' })
  ]
  for (const passed of ignored) {
    expect(waitingAskChange(passed.kind, passed.actor, passed.data)).toBeNull()
    expect(waitingOf([...waiting, passed])).toBe(waitingOf(waiting))
  }
  store.set(uid, { status: 'working' }, AGENT, NOW)
  const none = views()
  expect(waitingOf(none)).toBeUndefined()
  const answering = [
    event('commented', OWNER, { text: 'Yes' }),
    event('status', OWNER, { from: 'working', to: 'done' }),
    event('status', AGENT, { from: 'needs_you', to: 'working', cause: 'answer' })
  ]
  for (const passed of answering) {
    expect(waitingAskChange(passed.kind, passed.actor, passed.data)).toBe('answers')
    expect(waitingOf([...none, passed])).toBeUndefined()
  }
})
