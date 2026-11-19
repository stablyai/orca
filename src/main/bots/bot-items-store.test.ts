import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import type { BotItemAddInput, BotItemBotActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const owner: BotItemBotActor = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' }
const otherChat: BotItemBotActor = { kind: 'bot', botId: 'bot-a', chatId: 'chat-side' }
const stranger: BotItemBotActor = { kind: 'bot', botId: 'bot-b', chatId: 'chat-b' }
const ownerActor = { kind: 'owner' } as const
const NOW = 1_800_000_000_000
const HOUR = 60 * 60_000

const stores: BotItemsStore[] = []

function open(): BotItemsStore {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  return store
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose())
})

function input(overrides: Partial<BotItemAddInput> = {}): BotItemAddInput {
  return {
    ownerBotId: 'bot-a',
    chatId: 'chat-home',
    source: { kind: 'home', title: 'Home Chat' },
    title: 'Share dialog',
    status: 'planned',
    links: [],
    ...overrides
  }
}

describe('bot items store', () => {
  it('takes Needs you only with the question, and drops the question when it moves on', () => {
    const store = open()
    const { uid } = store.add(input(), owner)

    expect(() => store.set(uid, { status: 'needs_you' }, owner)).toThrow(/--comment/)
    store.set(uid, { status: 'needs_you', comment: 'Ship behind a flag?' }, owner)
    const asking = store.get(uid)
    expect(asking?.status).toBe('needs_you')
    const question = store.viewRows([uid]).questions[uid]
    expect(question?.data).toEqual({ text: 'Ship behind a flag?' })

    store.set(uid, { status: 'working' }, owner)
    expect(store.get(uid)?.questionEvent).toBeNull()
    expect(store.viewRows([uid]).questions[uid]).toBeUndefined()
  })

  it("marks the newest event anyone but the owner made, so the owner's own changes stay seen", () => {
    const store = open()
    const { uid } = store.add(input(), owner)
    const made = store.viewRows([uid]).othersLast[uid]

    store.ownerComment(uid, 'Use the outline button.', { kind: 'owner' })
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' })
    expect(store.viewRows([uid]).othersLast[uid]).toBe(made)

    const { eventId } = store.comment(uid, 'Switched to outline.', owner)
    expect(store.viewRows([uid]).othersLast[uid]).toBe(eventId)
  })

  it('pages Activity back from the newest event, oldest first in each page', () => {
    const store = open()
    const { uid } = store.add(input(), owner)
    for (const text of ['one', 'two', 'three']) {
      store.comment(uid, text, owner)
    }
    const texts = (events: { data: Record<string, unknown> }[]) =>
      events.map((event) => event.data.text ?? event.data.title)

    const newest = store.eventsBefore(uid, 0, 2)
    expect(texts(newest)).toEqual(['two', 'three'])
    expect(texts(store.eventsBefore(uid, newest[0]!.id, 2))).toEqual(['Share dialog', 'one'])
  })

  it('lets only the owner bot write its item', () => {
    const store = open()
    const { uid } = store.add(input(), owner)

    expect(() => store.comment(uid, 'Mine now', stranger)).toThrow(/belongs to another bot/)
    expect(() => store.set(uid, { title: 'Renamed' }, stranger)).toThrow(/belongs to another bot/)
  })

  it("owes the item chat mail for every owner change, and for another chat's writes, not its own", () => {
    const store = open()
    const { uid } = store.add(input(), owner)

    store.set(uid, { title: 'Share dialog v2' }, owner)
    store.ownerComment(uid, 'Use the short link', { kind: 'owner' })
    store.ownerStatus({ uids: [uid], to: 'done' }, { kind: 'owner' })
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' })
    store.set(uid, { status: 'planned' }, otherChat)

    const owed = store
      .owedMail(0)
      .mails.map((mail) => mail.changes.map(({ event }) => [event.kind, event.data.to ?? null]))
    expect(owed).toEqual([
      [['commented', null]],
      [['status', 'done']],
      [['status', 'working']],
      [['status', 'planned']]
    ])
    const ids = store.owedMail(0).mails.flatMap((mail) => mail.changes.map(({ event }) => event.id))
    store.markMailSent(ids)
    expect(store.owedMail(0)).toEqual({ mails: [], through: null })
  })

  it("owes one mail per owner action and chat: a bulk move, or a question's answer and move", () => {
    const store = open()
    const a = store.add(input({ title: 'A' }), owner).uid
    const b = store.add(input({ title: 'B' }), owner).uid
    const c = store.add(input({ title: 'C', chatId: 'chat-side' }), otherChat).uid

    store.ownerStatus({ uids: [a, b, c], to: 'done' }, { kind: 'owner' })
    store.ownerStatus({ uids: [a], to: 'working', comment: 'Ship it' }, { kind: 'owner' })

    const mails = store.owedMail(0).mails.map((mail) => ({
      chat: mail.chatId,
      changes: mail.changes.map(({ event, item }) => `${item.title} ${event.kind}`)
    }))
    expect(mails).toEqual([
      { chat: 'chat-home', changes: ['A status', 'B status'] },
      { chat: 'chat-side', changes: ['C status'] },
      { chat: 'chat-home', changes: ['A commented', 'A status'] }
    ])
  })

  it('links a worker started for an item once and moves Planned to In progress, never a closed item', () => {
    const store = open()
    const { uid } = store.add(input(), owner)
    const closed = store.add(input({ title: 'Old' }), owner).uid
    store.close(closed, 'done', undefined, owner)

    expect(store.linkStartedWorker(uid, 'ctx_1')).not.toBeNull()
    expect(store.linkStartedWorker(uid, 'ctx_1')).toBeNull()
    store.linkStartedWorker(closed, 'ctx_2')

    expect(store.get(uid)?.status).toBe('working')
    expect(store.links(uid).map((link) => link.ref)).toEqual(['ctx_1'])
    expect(store.get(closed)?.status).toBe('done')
  })

  it('lists only the items linking a PR when asked', () => {
    const store = open()
    store.add(input({ links: [{ kind: 'pr', ref: 'stablyai/orca#41180' }] }), owner)
    store.add(input({ title: 'Other' }), owner)

    const page = store.list({
      botId: 'bot-a',
      statuses: ['planned'],
      link: { kind: 'pr', ref: 'stablyai/orca#41180' },
      limit: 10
    })
    expect(page.items.map((item) => item.title)).toEqual(['Share dialog'])
  })

  it('reopens its own closed item, with field changes only alongside the reopen, and mails no one', () => {
    const store = open()
    const { uid } = store.add(input(), owner)
    store.close(uid, 'done', 'Shipped', owner)

    expect(() => store.set(uid, { title: 'Share dialog v2' }, owner)).toThrow(/reopen it/)
    expect(() => store.set(uid, { status: 'needs_you', comment: 'Again?' }, owner)).toThrow(
      /reopen it/
    )
    store.set(uid, { status: 'working', title: 'Share dialog v2' }, owner)

    expect(store.get(uid)).toMatchObject({
      status: 'working',
      title: 'Share dialog v2',
      closeNote: null,
      closedAt: null
    })
    const kinds = store.eventsBefore(uid, 0, 10).map((event) => [event.kind, event.data.to ?? null])
    expect(kinds.slice(-2)).toEqual([
      ['status', 'working'],
      ['edited', null]
    ])
    expect(store.owedMail(0).mails).toEqual([])
  })

  it('reopens an item the bot canceled, never one its owner canceled', () => {
    const store = open()
    const mine = store.add(input({ title: 'Mine' }), owner).uid
    const theirs = store.add(input({ title: 'Theirs' }), owner).uid
    store.close(mine, 'canceled', 'Not needed', owner)
    store.ownerStatus({ uids: [theirs], to: 'canceled', reason: 'Dropped' }, { kind: 'owner' })

    store.set(mine, { status: 'planned' }, owner)
    expect(store.get(mine)?.status).toBe('planned')
    expect(() => store.set(theirs, { status: 'planned' }, owner)).toThrow(/owner canceled/)
    expect(store.get(theirs)?.status).toBe('canceled')
    store.comment(theirs, 'Should I pick this back up?', owner)
  })

  it('records a comment with any status move', () => {
    const store = open()
    const { uid } = store.add(input(), owner)

    store.set(uid, { status: 'working', comment: 'Starting on the copy.' }, owner)

    const events = store.eventsBefore(uid, 0, 10).slice(-2)
    expect(events.map((event) => [event.kind, event.data.text ?? event.data.to])).toEqual([
      ['commented', 'Starting on the copy.'],
      ['status', 'working']
    ])
    expect(() => store.set(uid, { comment: 'No move' }, owner)).toThrow(/--comment goes with/)
  })

  it("moves a Needs you item to In progress with the owner's comment, and no other status or bot comment", () => {
    const store = open()
    const asking = store.add(input({ title: 'Asking' }), owner).uid
    const planned = store.add(input({ title: 'Planned' }), owner).uid
    const bots = store.add(input({ title: 'Bot comment' }), owner).uid
    store.set(asking, { status: 'needs_you', comment: 'Ship behind a flag?' }, owner)
    store.set(bots, { status: 'needs_you', comment: 'Which copy?' }, owner)

    store.ownerComment(asking, 'Yes, behind a flag.', { kind: 'owner' })
    store.ownerComment(planned, 'Use the short link.', { kind: 'owner' })
    store.comment(bots, 'Still checking.', otherChat)

    expect(store.get(asking)?.status).toBe('working')
    expect(store.get(asking)?.questionEvent).toBeNull()
    expect(store.get(planned)?.status).toBe('planned')
    expect(store.get(bots)?.status).toBe('needs_you')
    const answer = store.owedMail(0).mails.find((mail) => mail.changes[0]?.item.uid === asking)
    expect(answer?.changes.map(({ event }) => [event.kind, event.data.to ?? null])).toEqual([
      ['commented', null],
      ['status', 'working']
    ])
  })

  it('closes with set: done like `done`, canceled only with a reason like `cancel`', () => {
    const store = open()
    const a = store.add(input({ title: 'A' }), owner).uid
    const b = store.add(input({ title: 'B' }), owner).uid

    store.set(a, { status: 'done', note: 'Merged' }, owner)
    expect(() => store.set(b, { status: 'canceled' }, owner)).toThrow(/needs a reason/)
    store.set(b, { status: 'canceled', reason: 'Superseded' }, owner)

    expect(store.get(a)).toMatchObject({ status: 'done', closeNote: 'Merged' })
    expect(store.get(b)).toMatchObject({ status: 'canceled', closeNote: 'Superseded' })
    expect(store.get(b)?.closedAt).not.toBeNull()
  })

  it('takes a description up to 20,000 characters', () => {
    const store = open()

    const { uid } = store.add(input({ description: 'x'.repeat(20_000) }), owner)
    expect(store.get(uid)?.description).toHaveLength(20_000)
    expect(() => store.add(input({ description: 'x'.repeat(20_001) }), owner)).toThrow(
      /limit is 20000/
    )
  })

  it('lets the bot that made an item with --for comment on it, owing no item mail: its request is the mail', () => {
    const store = open()
    const { uid } = store.add(input({ madeBy: { botId: 'bot-b', chatId: 'chat-b' } }), stranger)

    store.comment(uid, 'The spec moved to v2.', stranger)
    expect(() => store.set(uid, { title: 'Mine now' }, stranger)).toThrow(/belongs to another bot/)
    const third: BotItemBotActor = { kind: 'bot', botId: 'bot-c', chatId: 'chat-c' }
    expect(() => store.comment(uid, 'Hi', third)).toThrow(/belongs to another bot/)
    expect(store.eventsBefore(uid, 0, 10).at(-1)?.data).toEqual({ text: 'The spec moved to v2.' })
    expect(store.owedMail(0).mails).toEqual([])
  })
  it('reads Needs you and item views without visiting every item or event', () => {
    const count = 20
    const dir = mkdtempSync(join(tmpdir(), 'bot-items-plan-'))
    const path = join(dir, 'bot-items.sqlite')
    const store = BotItemsStore.open(path)
    stores.push(store)
    const reader = new SyncDatabase(path)
    const uids: string[] = []
    for (let index = 0; index < count; index += 1) {
      const { uid } = store.add(input(), owner)
      store.ownerComment(uid, 'Looks good.', { kind: 'owner' })
      store.comment(uid, 'Thanks.', owner)
      if (index >= 2) {
        store.close(uid, 'done', undefined, owner)
      }
      uids.push(uid)
    }
    for (const uid of uids.slice(0, 2)) {
      store.set(uid, { status: 'needs_you', comment: 'Ship it?' }, owner)
    }
    const prepare = vi.spyOn(SyncDatabase.prototype, 'prepare')

    expect(store.needsYou()).toHaveLength(2)
    expect(Object.keys(store.viewRows(uids.slice(0, 20)).othersLast)).toHaveLength(20)
    const sql = prepare.mock.calls.map(([statement]) => statement)
    prepare.mockRestore()
    const plans = sql.flatMap((statement) =>
      ['needs_you', 'item_events'].some((word) => statement.includes(word))
        ? planOf(reader, statement).filter((detail) => /\bitem/.test(detail))
        : []
    )
    reader.close()
    rmSync(dir, { recursive: true, force: true })
    expect(plans).toEqual([
      // The partial index holds only Needs you items.
      'SCAN items USING COVERING INDEX idx_items_needs_you',
      // Only the questions, by id.
      'SEARCH item_events USING INTEGER PRIMARY KEY (rowid=?)'
    ])
  })

  it('fills who last wrote besides the owner on items an older file holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-items-migrate-'))
    try {
      const path = join(dir, 'bot-items.sqlite')
      const first = BotItemsStore.open(path)
      const { uid } = first.add(input(), owner)
      const { eventId } = first.comment(uid, 'Switched to outline.', owner)
      first.ownerComment(uid, 'Use the outline button.', { kind: 'owner' })
      const quiet = first.add(input(), owner).uid
      first.dispose()
      const older = new SyncDatabase(path)
      older.exec(`DROP INDEX idx_items_needs_you; ALTER TABLE items DROP COLUMN others_last_event_id;
        ALTER TABLE items DROP COLUMN snoozed_until; PRAGMA user_version = 1`)
      older.close()

      const store = BotItemsStore.open(path)
      stores.push(store)
      const made = store.events(quiet, 0, 1)[0]?.id

      expect(store.viewRows([uid, quiet]).othersLast).toEqual({ [uid]: eventId, [quiet]: made })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a snooze through the bot's comments and in-progress moves, and ends it on a new question or a close", () => {
    const store = open()
    const until = NOW + HOUR
    const { uid } = store.add(input(), owner)
    store.set(uid, { status: 'needs_you', comment: 'Ship behind a flag?' }, owner)
    const seen = store.viewRows([uid]).othersLast[uid] ?? 0
    store.ownerSnooze({ items: [{ uid, othersLastEventId: seen }], until }, ownerActor, NOW)

    expect(store.get(uid)?.snoozedUntil).toBe(until)
    // The bot's own writes owe no mail, so anything owed would be the snooze's.
    expect(store.owedMail(0).mails).toEqual([])
    store.comment(uid, 'Worker finished; PR is green.', owner)
    store.set(uid, { status: 'working' }, owner)
    expect(store.get(uid)?.snoozedUntil).toBe(until)

    store.set(uid, { status: 'needs_you', comment: 'Merge it?' }, owner)
    expect(store.get(uid)?.snoozedUntil).toBeNull()

    const other = store.add(input(), owner).uid
    const otherSeen = store.viewRows([other]).othersLast[other] ?? 0
    store.ownerSnooze(
      { items: [{ uid: other, othersLastEventId: otherSeen }], until },
      ownerActor,
      NOW
    )
    store.close(other, 'done', undefined, owner)
    expect(store.get(other)?.snoozedUntil).toBeNull()
  })

  it("ends a snooze on the owner's own comment or status move", () => {
    const store = open()
    const until = NOW + HOUR
    const snooze = (uid: string) =>
      store.ownerSnooze(
        { items: [{ uid, othersLastEventId: store.viewRows([uid]).othersLast[uid] ?? 0 }], until },
        ownerActor,
        NOW
      )
    const commented = store.add(input(), owner).uid
    snooze(commented)
    store.ownerComment(commented, 'Go with outline.', ownerActor)
    expect(store.get(commented)?.snoozedUntil).toBeNull()

    const moved = store.add(input(), owner).uid
    snooze(moved)
    store.ownerStatus({ uids: [moved], to: 'working' }, ownerActor)
    expect(store.get(moved)?.snoozedUntil).toBeNull()
  })

  it('refuses a snooze when the bot wrote on the item after the view the owner snoozed from', () => {
    const store = open()
    const { uid } = store.add(input(), owner)
    const seen = store.viewRows([uid]).othersLast[uid] ?? 0
    store.set(uid, { status: 'needs_you', comment: 'Ship behind a flag?' }, owner)

    expect(() =>
      store.ownerSnooze(
        { items: [{ uid, othersLastEventId: seen }], until: NOW + HOUR },
        ownerActor,
        NOW
      )
    ).toThrow(/changed since you looked/)
    expect(store.get(uid)?.snoozedUntil).toBeNull()
  })

  it("snoozes a selection over the bot's comments since the view, which don't bring an item back", () => {
    const store = open()
    const commented = store.add(input(), owner).uid
    const quiet = store.add(input(), owner).uid
    const seen = (uid: string) => store.viewRows([uid]).othersLast[uid] ?? 0
    const view = [
      { uid: commented, othersLastEventId: seen(commented) },
      { uid: quiet, othersLastEventId: seen(quiet) }
    ]
    store.comment(commented, 'Worker finished; PR is green.', owner)

    store.ownerSnooze({ items: view, until: NOW + HOUR }, ownerActor, NOW)

    expect(store.get(commented)?.snoozedUntil).toBe(NOW + HOUR)
    expect(store.get(quiet)?.snoozedUntil).toBe(NOW + HOUR)
  })

  it('says in Activity when a snooze ends early, and not when it had already run out', () => {
    const store = open()
    const { uid } = store.add(input(), owner)
    const seen = store.viewRows([uid]).othersLast[uid] ?? 0
    store.ownerSnooze(
      { items: [{ uid, othersLastEventId: seen }], until: NOW + HOUR },
      ownerActor,
      NOW
    )

    store.set(uid, { status: 'needs_you', comment: 'Merge it?' }, owner, NOW + 1)
    const early = store
      .events(uid, 0, 50)
      .filter((event) => event.kind === 'unsnoozed')
      .map((event) => event.data)
    expect(early).toEqual([{ early: true }])

    const later = store.add(input(), owner).uid
    const laterSeen = store.viewRows([later]).othersLast[later] ?? 0
    store.ownerSnooze(
      { items: [{ uid: later, othersLastEventId: laterSeen }], until: NOW + HOUR },
      ownerActor,
      NOW
    )
    store.close(later, 'done', undefined, owner, NOW + 2 * HOUR)
    expect(store.events(later, 0, 50).some((event) => event.kind === 'unsnoozed')).toBe(false)
    expect(store.get(later)?.snoozedUntil).toBeNull()
  })
})

function planOf(db: SyncDatabase, statement: string): string[] {
  const args = Array.from({ length: statement.split('?').length - 1 }, () => '[]')
  return db
    .prepare(`EXPLAIN QUERY PLAN ${statement}`)
    .all(...args)
    .map((row) => String(row.detail))
}
