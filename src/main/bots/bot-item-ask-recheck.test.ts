// Open asks get re-verified: an item ask unanswered for an hour wakes its bot's Home Chat once, silently,
// and the bot withdraws it by its ask id when its premise no longer holds. Real items and mail files.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-mail-sender'
import { botItemQuestionPairing } from '../../shared/bots/bot-item-question-answers'
import { botItemEventId } from '../../shared/bots/bot-items'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { sessionMailTaker } from '../runtime/orchestration/db/messages/mail-taker'
import { structuredMailOwed } from '../runtime/orchestration/mailbox/structured-mail/structured-mail-custody'
import {
  ASK_RECHECK_AFTER_MS,
  BotItemAskRechecks,
  botItemAskRecheckMailId,
  type BotItemAskRecheckDeps
} from './bot-item-ask-recheck'
import type { BotItemsRemote } from './bot-items-ops'
import { eventViewOf } from './bot-items-rows'
import { BotItemsStore } from './bot-items-store'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = 1_800_000_000_000
const HOME = '54889ba4-947c-4531-8221-8ab6aea262a9'
const THREAD = '2b86d615-52cf-490c-9514-563960ec11d0'
const MEMBER = 'bot-group-member-6f1c2d'
const OTHER_HOME = '9745ea23-ea63-43d8-9a38-7ac457e021b7'
const BOT_ID = 'eng-reviewer'
const OTHER_BOT_ID = 'ux-designer'
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const SIGN_IN = 'Can you sign in to Antigravity?'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function actor(chatId: string, botId = BOT_ID): BotItemBotActor {
  return { kind: 'bot', botId, chatId }
}

function botOf(id: string, home: string, extra: Partial<Bot> = {}): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only these fields.
  return { id, name: id, chatSessionId: home, paused: false, ...extra } as Bot
}

/** The worker's async face of a store this test opens in-process. */
function remoteOf(store: BotItemsStore): BotItemsRemote {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every op answers as the store's own method.
  return new Proxy(store, {
    get: (target, op) => {
      const value: unknown = Reflect.get(target, op)
      return typeof value === 'function'
        ? (...args: unknown[]) => Promise.resolve().then(() => value.apply(target, args))
        : value
    }
  }) as unknown as BotItemsRemote
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ask-recheck-'))
  const itemsPath = join(dir, 'bot-items.sqlite')
  const mailPath = join(dir, 'orchestration.sqlite')
  const state = {
    itemsPath,
    store: BotItemsStore.open(itemsPath),
    db: new OrchestrationDb(mailPath),
    bots: [botOf(BOT_ID, HOME), botOf(OTHER_BOT_ID, OTHER_HOME)],
    held: new Set<string>(),
    homeAsked: [] as string[],
    arrived: [] as { to: string; at: number }[],
    queueWoken: [] as string[],
    now: T0
  }
  cleanups.push(() => {
    state.store.dispose()
    state.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const deps = (): BotItemAskRecheckDeps => ({
    store: () => remoteOf(state.store),
    db: () => state.db,
    bots: () => state.bots,
    homeChat: (bot) => {
      state.homeAsked.push(bot.id)
      return bot.chatSessionId
    },
    holdsMail: async (sessionId) => state.held.has(sessionId),
    notifyArrived: (to) => state.arrived.push({ to, at: state.now }),
    wakeQueue: (sessionId) => state.queueWoken.push(sessionId),
    chatTitle: (chatId) => (chatId === THREAD ? 'Review of #51618' : null)
  })
  let rechecks = new BotItemAskRechecks(deps())
  const tick = async (at: number) => {
    state.now = at
    await rechecks.tick(at)
  }
  const changed = async (uids: string[], at: number) => {
    state.now = at
    await rechecks.itemsChanged(uids, at)
  }
  /** A restart: both files reopened, the pass rebuilt with nothing in memory. */
  const restart = () => {
    state.store.dispose()
    state.db.close()
    state.store = BotItemsStore.open(itemsPath)
    state.db = new OrchestrationDb(mailPath)
    rechecks = new BotItemAskRechecks(deps())
  }
  const item = (chatId = THREAD, at = T0, botId = BOT_ID) =>
    state.store.add(
      {
        ownerBotId: botId,
        chatId,
        source: { kind: chatId === THREAD ? 'thread' : 'chat', title: null },
        title: 'Review PR #51618',
        status: 'working',
        links: []
      },
      actor(chatId, botId),
      at
    ).uid
  /** The bot's Needs you ask; its open ask id. */
  const ask = (uid: string, at: number, prompt = SIGN_IN, chatId = THREAD, botId = BOT_ID) => {
    state.store.set(
      uid,
      {
        status: 'needs_you',
        comment: 'agy printed "Please sign in", so the review is held.',
        ask: { questions: [{ prompt, options: [{ label: 'Signed in' }, { label: 'Skip agy' }] }] }
      },
      actor(chatId, botId),
      at
    )
    return state.store.get(uid)!.questionEvent!
  }
  const mail = (askId: number) => state.db.getMessageById(botItemAskRecheckMailId(askId))
  const owed = (askId: number, sessionId = HOME) =>
    structuredMailOwed({
      db: state.db,
      sessionId,
      mailboxHandle: `orca_session_id:${sessionId}`,
      messageIds: [botItemAskRecheckMailId(askId)],
      resolve: () => ({ sessionId, dispatchId: null }),
      unresolved: () => 'unverifiable',
      ended: () => false
    })
  const withdraw = (uid: string, askId: number, reason: string, at: number, chatId = HOME) =>
    state.store.withdrawAsk(uid, askId, reason, actor(chatId), at)
  return { state, tick, changed, restart, item, ask, mail, owed, withdraw }
}

it('replays the incident: one silent wake at 1 h, the bot re-probes, withdraws, and the review goes on', async () => {
  const r = rig()
  const uid = r.item()
  const askId = r.ask(uid, T0)
  const eventsAfterAsk = r.state.store.events(uid, 0, 100).length
  // The non-compliant bot: it never re-probes on its own, only when mail wakes it.
  let probes = 0
  const probe = () => {
    probes++
    return 'signed in'
  }

  await r.tick(T0 + 59 * MIN)
  expect(r.mail(askId)).toBeUndefined()
  expect(probes).toBe(0)

  await r.tick(T0 + ASK_RECHECK_AFTER_MS)
  const wake = r.mail(askId)!
  expect(wake).toBeDefined()
  expect(wake.from_handle).toBe(BOT_ITEM_MAIL_SENDER)
  // Home Chat, never the Slack thread chat that asked.
  expect(wake.to_handle).toBe(`orca_session_id:${HOME}`)
  const number = r.state.store.get(uid)!.number
  expect(wake.body).toContain(`#${number}`)
  expect(wake.body).toContain(`orca bot item ask withdraw ${number} --ask ${botItemEventId(askId)}`)
  expect(wake.body).toContain('Your entire final message is exactly NO_REPLY')
  expect(wake.body).toContain(SIGN_IN)
  expect(JSON.parse(wake.payload!)).toMatchObject({
    recheck: { uid, ask: botItemEventId(askId) }
  })
  expect(r.state.arrived).toEqual([{ to: `orca_session_id:${HOME}`, at: T0 + HOUR }])
  // The wake is mail only: nothing on the item, so nothing for the owner.
  expect(r.state.store.events(uid, 0, 100)).toHaveLength(eventsAfterAsk)
  expect(r.owed(askId)).toBe('owed')

  // Delivery: the bot reads its mail, re-runs the check, and withdraws by the ask id it was given.
  r.state.db.markAsRead([wake.id], sessionMailTaker(HOME))
  expect(probe()).toBe('signed in')
  r.withdraw(uid, askId, 'Antigravity is signed in again.', T0 + HOUR + 2 * MIN)

  const after = r.state.store.get(uid)!
  expect(after.status).toBe('working')
  expect(after.questionEvent).toBeNull()
  expect(r.state.store.needsYou()).toHaveLength(0)
  const last = r.state.store.events(uid, 0, 100).at(-1)!
  expect(last).toMatchObject({
    kind: 'status',
    data: {
      from: 'needs_you',
      to: 'working',
      cause: 'withdrawn',
      note: 'Antigravity is signed in again.',
      ask: askId
    }
  })
  expect(r.state.store.askRecheckOutcomes()).toEqual({ sent: 1, withdrawn: 1, skippedStale: 0 })
  // The card reads Withdrawn: the ask's open line ended with the withdraw.
  const pairing = botItemQuestionPairing(
    { status: 'working' },
    r.state.store.events(uid, 0, 100).map(eventViewOf)
  )
  expect(pairing.questions.get(botItemEventId(askId))?.ended).toBe('withdrawn')
})

it('leaves an ask whose premise still holds: one wake, no reply, no second wake', async () => {
  const r = rig()
  const uid = r.item()
  const askId = r.ask(uid, T0)
  const eventsAfterAsk = r.state.store.events(uid, 0, 100).length
  for (let at = T0; at <= T0 + 3 * DAY; at += 10 * MIN) {
    await r.tick(at)
  }
  expect(r.state.arrived).toHaveLength(1)
  expect(r.state.db.getAllMessages(`orca_session_id:${HOME}`, 50)).toHaveLength(1)
  expect(r.state.store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: askId })
  expect(r.state.store.events(uid, 0, 100)).toHaveLength(eventsAfterAsk)
  expect(r.state.store.askRecheckOutcomes()).toEqual({ sent: 1, withdrawn: 0, skippedStale: 0 })
}, 60_000)

it('never wakes for an ask answered, closed or still snoozed before it is due', async () => {
  const r = rig()
  const answered = r.item()
  const answeredAsk = r.ask(answered, T0)
  r.state.store.ownerComment(answered, 'Signed in', OWNER, [], T0 + 20 * MIN, undefined, answeredAsk)
  const closed = r.item()
  const closedAsk = r.ask(closed, T0)
  r.state.store.close(closed, 'canceled', 'Review dropped.', actor(THREAD), undefined, T0 + 30 * MIN)
  const snoozed = r.item()
  const snoozedAsk = r.ask(snoozed, T0)
  r.state.store.ownerSnooze(
    {
      items: [{ uid: snoozed, othersLastEventId: r.state.store.get(snoozed)!.lastEventId }],
      until: T0 + 3 * HOUR
    },
    OWNER,
    T0 + 10 * MIN
  )
  for (let at = T0; at < T0 + 3 * HOUR; at += MIN) {
    await r.tick(at)
  }
  expect(r.mail(answeredAsk)).toBeUndefined()
  expect(r.mail(closedAsk)).toBeUndefined()
  expect(r.mail(snoozedAsk)).toBeUndefined()
  // Back from its snooze and still open: its one wake comes now.
  await r.tick(T0 + 3 * HOUR + MIN)
  expect(r.mail(snoozedAsk)).toBeDefined()
  expect(r.state.arrived).toHaveLength(1)
})

it('times a replaced ask from the new ask, and an unrelated Needs you comment does not restart it', async () => {
  const r = rig()
  const uid = r.item()
  const first = r.ask(uid, T0)
  const second = r.ask(uid, T0 + 30 * MIN, 'Use the Gemini CLI instead of agy?')
  // A later Needs you comment that asks nothing leaves the second ask waiting.
  r.state.store.set(
    uid,
    { status: 'needs_you', comment: 'Still holding the review.' },
    actor(THREAD),
    T0 + 50 * MIN
  )
  for (let at = T0; at <= T0 + 2 * HOUR; at += MIN) {
    await r.tick(at)
  }
  expect(r.mail(first)).toBeUndefined()
  const wake = r.mail(second)!
  expect(wake).toBeDefined()
  expect(r.state.arrived).toEqual([{ to: `orca_session_id:${HOME}`, at: T0 + 90 * MIN }])
})

it('retires a queued wake whose ask was answered before the bot took it: no turn', async () => {
  const r = rig()
  const uid = r.item()
  const askId = r.ask(uid, T0)
  await r.tick(T0 + HOUR)
  expect(r.owed(askId)).toBe('owed')

  r.state.store.ownerComment(uid, 'Signed in', OWNER, [], T0 + HOUR + 5 * MIN, undefined, askId)
  await r.changed([uid], T0 + HOUR + 5 * MIN)

  expect(r.state.db.areUnreadMessages(`orca_session_id:${HOME}`, [r.mail(askId)!.id])).toBe(false)
  expect(r.owed(askId)).toBe('stale')
  expect(r.state.queueWoken).toEqual([HOME])
})

it('refuses a withdraw naming an ask that is no longer the open one', async () => {
  const r = rig()
  const uid = r.item()
  const first = r.ask(uid, T0)
  await r.tick(T0 + HOUR)
  const second = r.ask(uid, T0 + HOUR + MIN, 'Use the Gemini CLI instead of agy?')

  expect(() => r.withdraw(uid, first, 'Antigravity is signed in again.', T0 + HOUR + 2 * MIN)).toThrow(
    expect.objectContaining({ code: 'question_closed' })
  )
  expect(r.state.store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: second })
  expect(() => r.withdraw(uid, second, '', T0 + HOUR + 3 * MIN)).toThrow(
    expect.objectContaining({ code: 'invalid_argument' })
  )
  expect(() => r.withdraw(uid, second, 'x'.repeat(141), T0 + HOUR + 3 * MIN)).toThrow(
    expect.objectContaining({ code: 'invalid_argument' })
  )
})

it('settles an owner answer racing a withdraw: whichever lands first wins, nothing is lost', async () => {
  const r = rig()
  // Owner first: the withdraw is refused and the answer stands.
  const answered = r.item()
  const answeredAsk = r.ask(answered, T0)
  r.state.store.ownerComment(answered, 'Signed in', OWNER, [], T0 + HOUR, undefined, answeredAsk)
  expect(() => r.withdraw(answered, answeredAsk, 'Signed in again.', T0 + HOUR + 1)).toThrow(
    expect.objectContaining({ code: 'question_closed' })
  )
  expect(r.state.store.events(answered, 0, 100).at(-1)?.data).toMatchObject({ cause: 'answer' })

  // Withdraw first: the owner's late quick reply posts as a comment; the item stays In progress.
  const withdrawn = r.item()
  const withdrawnAsk = r.ask(withdrawn, T0)
  r.withdraw(withdrawn, withdrawnAsk, 'Antigravity is signed in again.', T0 + HOUR)
  r.state.store.ownerComment(withdrawn, 'Signed in', OWNER, [], T0 + HOUR + 1, undefined, withdrawnAsk)
  const late = r.state.store.events(withdrawn, 0, 100).at(-1)!
  expect(late).toMatchObject({ kind: 'commented', actor: OWNER, data: { text: 'Signed in' } })
  expect(r.state.store.get(withdrawn)!.status).toBe('working')
})

it('wakes the Home Chat for an ask made in a Bot Group room, never the member chat', async () => {
  const r = rig()
  const uid = r.item(MEMBER)
  const askId = r.ask(uid, T0, SIGN_IN, MEMBER)
  await r.tick(T0 + HOUR)
  expect(r.mail(askId)?.to_handle).toBe(`orca_session_id:${HOME}`)
  expect(r.state.db.getAllMessages(`orca_session_id:${MEMBER}`, 50)).toHaveLength(0)
})

it('does not touch a paused bot or a held chat, and wakes once each is free', async () => {
  const r = rig()
  const uid = r.item()
  const askId = r.ask(uid, T0)
  r.state.bots = [botOf(BOT_ID, HOME, { paused: true })]
  await r.tick(T0 + HOUR)
  expect(r.mail(askId)).toBeUndefined()
  // Skipped before any chat is resolved: nothing created or shown for it.
  expect(r.state.homeAsked).toEqual([])
  expect(r.state.store.askRecheckOutcomes().sent).toBe(0)

  // Its usage limit holds Home Chat's mail: deferred, nothing recorded.
  r.state.bots = [botOf(BOT_ID, HOME)]
  r.state.held.add(HOME)
  await r.tick(T0 + HOUR + MIN)
  expect(r.mail(askId)).toBeUndefined()
  expect(r.state.store.askRecheckOutcomes().sent).toBe(0)

  r.state.held.delete(HOME)
  await r.tick(T0 + HOUR + 2 * MIN)
  expect(r.mail(askId)).toBeDefined()

  // No Home Chat taking mail now: deferred, never created.
  const other = r.item(THREAD, T0, OTHER_BOT_ID)
  const otherAsk = r.ask(other, T0, SIGN_IN, THREAD, OTHER_BOT_ID)
  r.state.bots = [botOf(BOT_ID, HOME), botOf(OTHER_BOT_ID, OTHER_HOME, { chatSessionId: null })]
  await r.tick(T0 + 2 * HOUR)
  expect(r.mail(otherAsk)).toBeUndefined()
})

it('survives restarts: one wake at 1 h, never a second, and repairs a wake sent but not recorded', async () => {
  const r = rig()
  const uid = r.item()
  const askId = r.ask(uid, T0)
  await r.tick(T0 + 30 * MIN)
  r.restart()
  await r.tick(T0 + HOUR)
  expect(r.mail(askId)).toBeDefined()
  r.restart()
  await r.tick(T0 + HOUR + MIN)
  await r.tick(T0 + 5 * HOUR)
  expect(r.state.db.getAllMessages(`orca_session_id:${HOME}`, 50)).toHaveLength(1)
  expect(r.state.arrived).toHaveLength(1)

  // A crash between the message and its record: the next pass records it and tells the chat again.
  const crashed = r.item()
  const crashedAsk = r.ask(crashed, T0 + 6 * HOUR)
  r.state.db.insertMessage({
    id: botItemAskRecheckMailId(crashedAsk),
    from: BOT_ITEM_MAIL_SENDER,
    to: `orca_session_id:${HOME}`,
    type: 'status',
    subject: 'Item question re-check',
    body: 'wake',
    orcaAuthored: 'item-mail'
  })
  r.restart()
  await r.tick(T0 + 7 * HOUR)
  await r.tick(T0 + 8 * HOUR)
  expect(r.state.db.getAllMessages(`orca_session_id:${HOME}`, 50)).toHaveLength(2)
  expect(r.state.arrived.filter((entry) => entry.at === T0 + 7 * HOUR)).toHaveLength(1)
  expect(r.state.store.askRecheckOutcomes().sent).toBe(2)
})

it('sweeps a backlog at three wakes per ten minutes, skips held chats without blocking, and skips Stale asks for good', async () => {
  const r = rig()
  const start = T0 + 10 * DAY
  const asks: { askId: number; age: number }[] = []
  for (let index = 0; index < 100; index++) {
    // From just over an hour to ten days old; the bot's default stale days are 5.
    const age = HOUR + Math.floor((index * 10 * DAY) / 100)
    const uid = r.item(THREAD, start - age)
    asks.push({ askId: r.ask(uid, start - age), age })
  }
  // The oldest non-stale ask's bot is held; its asks wait while the rest still go.
  const heldUid = r.item(THREAD, start - 4 * DAY, OTHER_BOT_ID)
  const heldAsk = r.ask(heldUid, start - 4 * DAY, SIGN_IN, THREAD, OTHER_BOT_ID)
  r.state.held.add(OTHER_HOME)

  for (let at = start; at <= start + 6 * HOUR; at += MIN) {
    await r.tick(at)
  }
  const times = r.state.arrived.map((entry) => entry.at)
  for (const at of times) {
    expect(times.filter((other) => other > at - 10 * MIN && other <= at).length).toBeLessThanOrEqual(3)
  }
  const fresh = asks.filter(({ age }) => age < 5 * DAY)
  const stale = asks.filter(({ age }) => age >= 5 * DAY)
  for (const { askId } of fresh) {
    expect(r.mail(askId)).toBeDefined()
  }
  for (const { askId } of stale) {
    expect(r.mail(askId)).toBeUndefined()
  }
  expect(r.mail(heldAsk)).toBeUndefined()
  expect(r.state.store.askRecheckOutcomes()).toEqual({
    sent: fresh.length,
    withdrawn: 0,
    skippedStale: stale.length
  })
}, 120_000)

it('does nothing on a read-only items file, and withdraw works without the side table', async () => {
  const r = rig()
  const uid = r.item()
  const askId = r.ask(uid, T0)
  // Another build dropped the side table: the pass is a no-op, the bot can still withdraw.
  const file = new DatabaseSync(r.state.itemsPath)
  file.exec('DROP TABLE IF EXISTS item_ask_rechecks')
  file.close()
  await r.tick(T0 + HOUR)
  expect(r.mail(askId)).toBeUndefined()
  r.withdraw(uid, askId, 'Antigravity is signed in again.', T0 + HOUR + MIN)
  expect(r.state.store.get(uid)!.status).toBe('working')

  // A file a newer Orca wrote opens read-only: the pass reads nothing and throws nothing.
  const readOnly = rig()
  const roUid = readOnly.item()
  const roAsk = readOnly.ask(roUid, T0)
  const roFile = new DatabaseSync(readOnly.state.itemsPath)
  roFile.exec('PRAGMA user_version = 999')
  roFile.close()
  readOnly.restart()
  await expect(readOnly.tick(T0 + HOUR)).resolves.toBeUndefined()
  expect(readOnly.mail(roAsk)).toBeUndefined()
})
