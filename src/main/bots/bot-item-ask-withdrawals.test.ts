import { afterEach, describe, expect, it } from 'vitest'
import { parseBotItemAskWhile, type BotItemAskWhile } from '../../shared/bots/bot-item-ask-while'
import type { BotItemAskWhileWorker } from './bot-item-ask-while-worker'
import { BotItemAskWithdrawals, type BotItemAskWithdrawalStore } from './bot-item-ask-withdrawals'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'home' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const NOW = Date.parse('2026-11-25T12:00:00Z')
const LATER = Date.parse('2026-11-27T09:00:00Z')
const ASK = {
  context: 'The reviewer is out.',
  questions: [{ prompt: 'Merge without review?', options: [] }]
}

describe('Needs you asks kept open --while', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function open(): BotItemsStore {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    return store
  }

  function asked(store: BotItemsStore, askWhile: BotItemAskWhile): string {
    const { uid } = store.add(
      {
        ownerBotId: BOT.botId,
        chatId: BOT.chatId,
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      BOT
    )
    store.set(uid, { status: 'needs_you', ask: ASK, askWhile }, BOT, NOW)
    return uid
  }

  function remote(store: BotItemsStore): BotItemAskWithdrawalStore {
    return {
      askWhileQuestions: async () => store.askWhileQuestions(),
      withdrawAsk: async (...args) => store.withdrawAsk(...args),
      stillOwed: async (ids) => store.stillOwed(ids),
      owedWithdrawals: async () => store.owedWithdrawals(),
      viewRows: async (uids) => store.viewRows(uids)
    }
  }

  function watcher(
    store: BotItemsStore,
    worker: (ref: string) => BotItemAskWhileWorker,
    sendOwedMail: () => Promise<void> = async () => {}
  ): BotItemAskWithdrawals {
    const wrapped = remote(store)
    return new BotItemAskWithdrawals({
      store: () => wrapped,
      worker,
      workerTitle: async () => new Map(),
      changed: () => {},
      sendOwedMail
    })
  }

  it('reads --while strictly: a zone on every time, only future times, only known kinds', () => {
    expect(parseBotItemAskWhile('until:2026-11-27T09:00:00Z', NOW)).toEqual({
      ok: true,
      value: { kind: 'until', at: LATER }
    })
    expect(parseBotItemAskWhile('until:2026-11-27T10:00+01:00', NOW)).toEqual({
      ok: true,
      value: { kind: 'until', at: LATER }
    })
    expect(parseBotItemAskWhile('dispatch:ctx_ab12', NOW)).toEqual({
      ok: true,
      value: { kind: 'dispatch', ref: 'ctx_ab12' }
    })
    for (const value of [
      'until:2026-11-27T09:00:00',
      'until:2026-11-27',
      'until:2026-11-24T09:00:00Z',
      'until:2027-02-29T09:00:00Z',
      'until:2026-11-27T24:00:00Z',
      'until:2028-11-27T09:00:00Z',
      'dispatch:',
      'dispatch:ctx a',
      'pr:acme/app#1',
      'worktree:wt1',
      ''
    ]) {
      expect(parseBotItemAskWhile(value, NOW).ok, value).toBe(false)
    }
  })

  it('keeps the condition on the ask, through a later comment that asks nothing, until a new ask', () => {
    const store = open()
    const uid = asked(store, { kind: 'until', at: LATER })
    expect(store.askWhileQuestions()).toEqual([
      { uid, questionEvent: store.get(uid)!.questionEvent, askWhile: { kind: 'until', at: LATER } }
    ])
    store.set(uid, { status: 'needs_you', comment: 'Still blocked on the review.' }, BOT, NOW + 1)
    const after = store.askWhileQuestions()
    expect(after).toEqual([
      { uid, questionEvent: store.get(uid)!.questionEvent, askWhile: { kind: 'until', at: LATER } }
    ])
    store.set(uid, { status: 'needs_you', ask: ASK }, BOT, NOW + 2)
    expect(store.askWhileQuestions()).toEqual([])
    expect(() =>
      store.set(uid, { status: 'needs_you', askWhile: { kind: 'until', at: LATER } }, BOT)
    ).toThrow(/--while goes with --status needs-you and an --ask/)
  })

  it('withdraws only the question still asked: an answer or a new ask first wins', () => {
    const store = open()
    const answered = asked(store, { kind: 'until', at: LATER })
    const answeredQuestion = store.get(answered)!.questionEvent!
    store.ownerComment(answered, 'Merge it.', OWNER, [], NOW + 1)
    expect(
      store.withdrawAsk(answered, answeredQuestion, { kind: 'until', at: LATER, state: 'passed' })
    ).toBeNull()
    expect(store.get(answered)!.status).toBe('working')

    const reasked = asked(store, { kind: 'until', at: LATER })
    const first = store.get(reasked)!.questionEvent!
    store.set(reasked, { status: 'needs_you', ask: ASK }, BOT, NOW + 1)
    expect(
      store.withdrawAsk(reasked, first, { kind: 'until', at: LATER, state: 'passed' })
    ).toBeNull()
    expect(store.get(reasked)!.status).toBe('needs_you')
  })

  it('withdraws when the time passes or the worker ends, never while it runs or reads unknown', async () => {
    const store = open()
    const timed = asked(store, { kind: 'until', at: LATER })
    const running = asked(store, { kind: 'dispatch', ref: 'ctx_run' })
    const unread = asked(store, { kind: 'dispatch', ref: 'ctx_unknown' })
    const ended = asked(store, { kind: 'dispatch', ref: 'ctx_done' })
    const states: Record<string, BotItemAskWhileWorker> = {
      ctx_run: 'running',
      ctx_unknown: 'unknown',
      ctx_done: 'completed'
    }
    const withdrawals = watcher(store, (ref) => states[ref] ?? 'unknown')

    withdrawals.tick(LATER - 1)
    await withdrawals.settled()
    expect([timed, running, unread, ended].map((uid) => store.get(uid)!.status)).toEqual([
      'needs_you',
      'needs_you',
      'needs_you',
      'working'
    ])

    withdrawals.tick(LATER)
    await withdrawals.settled()
    expect([timed, running, unread].map((uid) => store.get(uid)!.status)).toEqual([
      'working',
      'needs_you',
      'needs_you'
    ])
    const [move] = store.events(ended, store.get(ended)!.lastEventId - 1, 1)
    expect(move).toMatchObject({
      kind: 'status',
      actor: { kind: 'orca', why: 'ask-withdrawn' },
      data: {
        from: 'needs_you',
        to: 'working',
        cause: 'withdrawn',
        withdrawn: { kind: 'dispatch', ref: 'ctx_done', state: 'completed' }
      }
    })
    expect(store.viewRows([ended], true).waitingAsks[ended]).toBeUndefined()
  })

  it('refuses an owner reply naming a withdrawn question, and still takes a plain comment', () => {
    const store = open()
    const uid = asked(store, { kind: 'until', at: LATER })
    const question = store.get(uid)!.questionEvent!
    store.withdrawAsk(uid, question, { kind: 'until', at: LATER, state: 'passed' }, LATER)
    const late = () => store.ownerComment(uid, 'Yes', OWNER, [], LATER + 1, undefined, question)
    expect(late).toThrow(expect.objectContaining({ code: 'item_changed' }))
    // Still refused once the bot has moved on and closed the item.
    store.close(uid, 'done', undefined, BOT)
    expect(late).toThrow(expect.objectContaining({ code: 'item_changed' }))
    expect(store.ownerComment(uid, 'Noted.', OWNER, [], LATER + 2).eventId).not.toBeNull()

    // A later comment that asks nothing became the item's question; a reply naming the ask itself is
    // refused too.
    const twice = asked(store, { kind: 'until', at: LATER })
    const ask = store.get(twice)!.questionEvent!
    store.set(twice, { status: 'needs_you', comment: 'Still blocked.' }, BOT, NOW + 1)
    const comment = store.get(twice)!.questionEvent!
    expect(comment).not.toBe(ask)
    store.withdrawAsk(twice, comment, { kind: 'until', at: LATER, state: 'passed' }, LATER)
    expect(() => store.ownerComment(twice, 'Yes', OWNER, [], LATER + 1, undefined, ask)).toThrow(
      expect.objectContaining({ code: 'item_changed' })
    )
  })

  it('sends withdrawal mail a crash left owed on the first minute after a restart', async () => {
    const store = open()
    const uid = asked(store, { kind: 'until', at: LATER })
    const eventId = store.withdrawAsk(uid, store.get(uid)!.questionEvent!, {
      kind: 'until',
      at: LATER,
      state: 'passed'
    })!
    const restarted = watcher(
      store,
      () => 'unknown',
      async () => {
        store.markMailSent(
          store.owedMail(0).mails.flatMap((mail) => mail.changes.map((c) => c.event.id))
        )
      }
    )
    restarted.tick(LATER + 1)
    await restarted.settled()
    expect(store.stillOwed([eventId])).toEqual([])
  })

  it('sends the withdrawal’s mail with no other write, and tries a failed send again next minute', async () => {
    const store = open()
    const uid = asked(store, { kind: 'until', at: LATER })
    let attempts = 0
    const withdrawals = watcher(
      store,
      () => 'unknown',
      async () => {
        attempts++
        if (attempts === 1) {
          return
        }
        const { mails } = store.owedMail(0)
        store.markMailSent(mails.flatMap((mail) => mail.changes.map(({ event }) => event.id)))
      }
    )
    withdrawals.tick(LATER)
    await withdrawals.settled()
    const withdrawal = store.get(uid)!.lastEventId
    expect(store.stillOwed([withdrawal])).toEqual([withdrawal])
    withdrawals.tick(LATER + 60_000)
    await withdrawals.settled()
    expect(store.stillOwed([withdrawal])).toEqual([])
  })

  it('starts over for another profile, even after an idle minute in the first', async () => {
    const idle = open()
    const other = open()
    const uid = asked(other, { kind: 'until', at: LATER })
    const stores = [remote(idle), remote(other)]
    let current = 0
    const withdrawals = new BotItemAskWithdrawals({
      store: () => stores[current]!,
      worker: () => 'unknown',
      workerTitle: async () => new Map(),
      changed: () => {},
      sendOwedMail: async () => {}
    })
    withdrawals.tick(LATER)
    await withdrawals.settled()
    current = 1
    withdrawals.tick(LATER + 60_000)
    await withdrawals.settled()
    expect(other.get(uid)!.status).toBe('working')
  })

  it('tells the item lists of a withdrawal on the next minute when telling them failed', async () => {
    const store = open()
    const uid = asked(store, { kind: 'until', at: LATER })
    const told: string[] = []
    let reads = 0
    const wrapped: BotItemAskWithdrawalStore = {
      ...remote(store),
      viewRows: async (uids) => {
        reads++
        if (reads === 1) {
          throw new Error('busy')
        }
        return store.viewRows(uids)
      }
    }
    const withdrawals = new BotItemAskWithdrawals({
      store: () => wrapped,
      worker: () => 'unknown',
      workerTitle: async () => new Map(),
      changed: (items) => told.push(...items.map((item) => item.uid)),
      sendOwedMail: async () => {}
    })
    withdrawals.tick(LATER)
    await withdrawals.settled()
    expect(told).toEqual([])
    withdrawals.tick(LATER + 60_000)
    await withdrawals.settled()
    expect(told).toEqual([uid])
  })

  it('keeps a new profile’s owed mail when a pass for the old profile finishes after the switch', async () => {
    const before = open()
    const after = open()
    const uid = asked(after, { kind: 'until', at: LATER })
    const owedEvent = after.withdrawAsk(uid, after.get(uid)!.questionEvent!, {
      kind: 'until',
      at: LATER,
      state: 'passed'
    })!
    let release: () => void = () => {}
    const slow: BotItemAskWithdrawalStore = {
      ...remote(before),
      owedWithdrawals: () =>
        new Promise((resolve) => {
          release = () => resolve(before.owedWithdrawals())
        })
    }
    const stores = [slow, remote(after)]
    let current = 0
    const withdrawals = new BotItemAskWithdrawals({
      store: () => stores[current]!,
      worker: () => 'unknown',
      workerTitle: async () => new Map(),
      changed: () => {},
      sendOwedMail: async () => {
        const owed = after.owedMail(0).mails.flatMap((mail) => mail.changes.map((c) => c.event.id))
        if (current === 1) {
          after.markMailSent(owed)
        }
      }
    })
    withdrawals.tick(LATER)
    current = 1
    withdrawals.tick(LATER + 1)
    release()
    await withdrawals.settled()
    expect(after.stillOwed([owedEvent])).toEqual([])
  })

  it('tells the lists of a withdrawal on the next minute when a later write in its pass failed', async () => {
    const store = open()
    const first = asked(store, { kind: 'until', at: LATER })
    asked(store, { kind: 'until', at: LATER })
    const told: string[] = []
    let writes = 0
    const wrapped: BotItemAskWithdrawalStore = {
      ...remote(store),
      withdrawAsk: async (...args) => {
        writes++
        if (writes === 2) {
          throw new Error('busy')
        }
        return store.withdrawAsk(...args)
      }
    }
    const withdrawals = new BotItemAskWithdrawals({
      store: () => wrapped,
      worker: () => 'unknown',
      workerTitle: async () => new Map(),
      changed: (items) => told.push(...items.map((item) => item.uid)),
      sendOwedMail: async () => {}
    })
    withdrawals.tick(LATER)
    await withdrawals.settled()
    expect(told).toEqual([])
    withdrawals.tick(LATER + 60_000)
    await withdrawals.settled()
    expect(told).toContain(first)
  })
})
