// Security invariant: the bot-wide journal never files a close made for someone else as the owner's
// work; each such line names whom its closing turn acted for, and an unknown one says so.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function open() {
    const store = BotItemsStore.open(':memory:')
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

  async function journalOf(store: BotItemsStore): Promise<string | undefined> {
    const fs = memoryFs()
    const journal = createBotMemoryJournal({
      bots: () => [makeTestBot({ id: 'b1' })],
      closedItems: (botId, since) =>
        readClosedSince(
          async (query) => store.list({ botId, ...query }),
          async (records) =>
            records.map(({ number, title, status }) => ({ number, title, status, links: [] })),
          async (uids) => store.closes(uids),
          since
        ),
      folder: () => '/home',
      serialize: async (_botId, step) => step(),
      fs,
      now: () => CLOSED + 60_000
    })
    journal.itemsChanged(['b1'])
    await journal.settled()
    return fs.files.get(FILE)
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
    // A teammate's request relayed into Home Chat: the closing turn acted for them too.
    const relayed = [...OWNER, person('U_EVE', 'Eve | done', 'member')]
    store.close(add('Relayed request'), 'done', undefined, HOME, relayed, now())
    // The owner closes a teammate's item themselves.
    store.ownerStatus({ uids: [add('Owner closed', 'dana')], to: 'done' }, { kind: 'owner' }, now())
    // A close that kept no askers says it can't tell.
    store.set(add('Unattributed'), { status: 'done' }, HOME, now())
    store.set(add('Set by teammate'), { status: 'done', closedFor: [DANA] }, HOME, now())
    expect(await journalOf(store)).toBe(
      [
        '# Journal 2026-11',
        '- 2026-11-21 | item #1 | done | Owner typed',
        '- 2026-11-21 | item #2 | done | Owner via Slack',
        '- 2026-11-21 | item #3 | done | Teammate chat | for Dana via Slack, not your owner',
        '- 2026-11-21 | item #4 | done | Relayed request | for Eve / done via Slack, not your owner',
        '- 2026-11-21 | item #5 | done | Owner closed',
        '- 2026-11-21 | item #6 | done | Unattributed | asker unknown, not known to be your owner',
        '- 2026-11-21 | item #7 | done | Set by teammate | for Dana via Slack, not your owner',
        ''
      ].join('\n')
    )
  })

  it('reads whom an item closed for from its close, not a later reopen', () => {
    const { store, add, now } = open()
    const uid = add('Ship it')
    store.close(uid, 'done', undefined, { ...HOME, chatId: 'dana' }, [DANA], now())
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, now())
    expect(store.closes([uid, 'none'])).toEqual({
      [uid]: { actor: { ...HOME, chatId: 'dana' }, actsFor: [DANA] }
    })
  })
})
