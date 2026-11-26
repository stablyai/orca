// Security invariant: the bot-wide journal never files a close made for someone else as the owner's
// work; each such line names whom its closing chat acted for, and an unknown one says so.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { makeTestBot } from './bot.test-fixture'
import type { BotItemBotActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'
import { createBotMemoryJournal, readClosedSince } from './bot-memory-journal-runtime'

const CLOSED = new Date(2026, 10, 21, 15, 0).getTime()
const FILE = join('/home', 'memory', 'journal', '2026-11.md')
const HOME: BotItemBotActor = { kind: 'bot', botId: 'b1', chatId: 'home' }
const OWNER: BotRequestAsker[] = [{ kind: 'owner' }]
const person = (userId: string, name: string, role: 'owner' | 'member'): BotRequestAsker => ({
  kind: 'person',
  source: 'slack',
  userId,
  name,
  workspaceId: 'T1',
  role
})
const DANA = person('U_DANA', 'Dana', 'member')

function memoryFs() {
  const files = new Map<string, string>()
  return {
    files,
    readText: async (path: string) => files.get(path) ?? null,
    writeText: async (path: string, text: string, opts?: { exclusive?: boolean }) =>
      !(opts?.exclusive && files.has(path)) && (files.set(path, text), true),
    replaceText: async (path: string, expected: string, text: string) =>
      files.get(path) === expected && (files.set(path, text), true),
    makeDirectory: async () => {}
  }
}

describe("the journal's attribution of each close", () => {
  const stores: BotItemsStore[] = []
  const directories: string[] = []
  afterEach(() => {
    stores.splice(0).forEach((store) => store.dispose())
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }))
  })

  function open(path = ':memory:') {
    const store = BotItemsStore.open(path)
    stores.push(store)
    let at = CLOSED
    const add = (title: string, chatId = 'home') =>
      store.add(
        {
          ownerBotId: 'b1',
          chatId,
          source: { kind: 'home', title: null },
          title,
          status: 'working',
          links: []
        },
        { ...HOME, chatId },
        at++
      ).uid
    return { store, add, now: () => at++ }
  }

  function journalOf(store: BotItemsStore, fs = memoryFs()) {
    const read = { closes: 0 }
    const journal = createBotMemoryJournal({
      bots: () => [makeTestBot({ id: 'b1' })],
      closedItems: (botId, since, written) =>
        readClosedSince(
          async (query) => store.list({ botId, ...query }),
          async (records) =>
            records.map(({ number, title, status }) => ({ number, title, status, links: [] })),
          async (items) => (read.closes++, store.closes(items)),
          since,
          written
        ),
      folder: () => '/home',
      serialize: async (_botId, step) => step(),
      fs,
      now: () => CLOSED + 60_000
    })
    const pass = async () => {
      journal.itemsChanged(['b1'])
      await journal.settled()
      return fs.files.get(FILE)
    }
    return { pass, read, fs }
  }

  it('labels a close made for anyone but the owner, and keeps the owner’s lines as they were', async () => {
    const { store, add, now } = open()
    store.close(add('Owner typed'), 'done', undefined, HOME, OWNER, now())
    store.close(
      add('Owner via Slack'),
      'done',
      undefined,
      HOME,
      [person('U_O', 'O', 'owner')],
      now()
    )
    store.close(
      add('Teammate chat', 'dana'),
      'done',
      undefined,
      { ...HOME, chatId: 'dana' },
      [DANA],
      now()
    )
    // A chat shared by the owner and a teammate acts for the teammate too.
    const shared = [...OWNER, person('U_EVE', 'Eve | done', 'member')]
    store.close(add('Shared chat'), 'done', undefined, HOME, shared, now())
    // The owner closes a teammate's item themselves.
    store.ownerStatus({ uids: [add('Owner closed', 'dana')], to: 'done' }, { kind: 'owner' }, now())
    // A close that kept no askers says it can't tell.
    store.set(add('Unattributed'), { status: 'done' }, HOME, now())
    store.set(add('Set by teammate'), { status: 'done', closedFor: [DANA] }, HOME, now())
    const { pass, read } = journalOf(store)
    const journal = [
      '# Journal 2026-11',
      '- 2026-11-21 | item #1 | done | Owner typed',
      '- 2026-11-21 | item #2 | done | Owner via Slack',
      '- 2026-11-21 | item #3 | done | Teammate chat | for Dana via Slack, not your owner',
      '- 2026-11-21 | item #4 | done | Shared chat | for Eve / done via Slack, not your owner',
      '- 2026-11-21 | item #5 | done | Owner closed',
      '- 2026-11-21 | item #6 | done | Unattributed | asker unknown, not known to be your owner',
      '- 2026-11-21 | item #7 | done | Set by teammate | for Dana via Slack, not your owner',
      ''
    ].join('\n')
    expect(await pass()).toBe(journal)
    // A later pass with no new close reads no close again.
    expect(await pass()).toBe(journal)
    expect(read.closes).toBe(1)
  })

  it('reads each close by its own event, its asker and status, not those of one after a reopen', () => {
    const { store, add, now } = open()
    const uid = add('Ship it')
    const closedAt = now()
    store.close(uid, 'done', undefined, { ...HOME, chatId: 'dana' }, [DANA], closedAt)
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, now())
    const reclosedAt = now()
    store.ownerStatus({ uids: [uid], to: 'canceled' }, { kind: 'owner' }, reclosedAt)
    expect(
      store.closes([
        { uid, since: closedAt },
        { uid: 'none', since: closedAt }
      ])
    ).toEqual({
      [uid]: [
        {
          closedAt,
          status: 'done',
          actor: { ...HOME, chatId: 'dana' },
          actsFor: [DANA],
          closeNumber: 1
        },
        {
          closedAt: reclosedAt,
          status: 'canceled',
          actor: { kind: 'owner' },
          actsFor: null,
          closeNumber: 2
        }
      ]
    })
  })

  it('finds a close however many events came after it', () => {
    const { store, add, now } = open()
    const uid = add('Ship it')
    const closedAt = now()
    store.close(uid, 'done', undefined, HOME, OWNER, closedAt)
    for (let i = 0; i < 500; i++) {
      store.comment(uid, 'More', HOME, [], now())
    }
    expect(store.closes([{ uid, since: closedAt }])[uid]?.[0]?.actsFor).toEqual(OWNER)
  })

  it('journals each close of an item once, a later one the same day as its own line, across a restart', async () => {
    const { store, add, now } = open()
    const uid = add('Ship it')
    store.close(uid, 'done', undefined, HOME, OWNER, now())
    const { pass, fs } = journalOf(store)
    await pass()
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, now())
    store.close(uid, 'canceled', 'Not needed', { ...HOME, chatId: 'dana' }, [DANA], now())
    // A move between closed statuses is no new close.
    store.ownerStatus({ uids: [uid], to: 'done' }, { kind: 'owner' }, now())
    const journal = [
      '# Journal 2026-11',
      '- 2026-11-21 | item #1 | done | Ship it',
      '- 2026-11-21 | item #1 (close 2) | canceled | Ship it | for Dana via Slack, not your owner',
      ''
    ].join('\n')
    expect(await pass()).toBe(journal)
    // A restart reads the newest close again and knows it from the first.
    expect(await journalOf(store, fs).pass()).toBe(journal)
  })

  it('journals every close made between two passes, not only the newest', async () => {
    const { store, add, now } = open()
    const uid = add('Ship it')
    store.close(uid, 'done', undefined, HOME, OWNER, now())
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, now())
    store.close(uid, 'done', undefined, HOME, OWNER, now())
    expect(await journalOf(store).pass()).toBe(
      [
        '# Journal 2026-11',
        '- 2026-11-21 | item #1 | done | Ship it',
        '- 2026-11-21 | item #1 (close 2) | done | Ship it',
        ''
      ].join('\n')
    )
  })

  it('adds nothing for closes an older Orca made and journaled, and numbers the next close after them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bot-journal-'))
    directories.push(directory)
    const path = join(directory, 'bot-items.sqlite')
    const { store, add, now } = open(path)
    const uid = add('Ship it')
    store.close(uid, 'done', undefined, HOME, OWNER, now())
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, now())
    store.close(uid, 'done', undefined, HOME, OWNER, now())
    // An older Orca numbered no close, and journaled only the newest under the date and item.
    const older = new SyncDatabase(path)
    older.exec("UPDATE item_events SET data = json_remove(data, '$.closeNumber')")
    older.close()
    const { pass, fs } = journalOf(store)
    const before = ['# Journal 2026-11', '- 2026-11-21 | item #1 | done | Ship it', ''].join('\n')
    fs.files.set(FILE, before)
    expect(await pass()).toBe(before)
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, now())
    store.close(uid, 'done', undefined, HOME, OWNER, now())
    expect(await pass()).toBe(
      [
        ...before.split('\n').slice(0, -1),
        '- 2026-11-21 | item #1 (close 3) | done | Ship it',
        ''
      ].join('\n')
    )
  })
})
