// Security invariant: the bot-wide journal never files a close from someone else's chat as the
// owner's work; each such line names whom its chat acted for, and an unknown chat says so.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotItemActor } from '../../shared/bots/bot-items'
import { makeTestBot } from './bot.test-fixture'
import { BotItemsStore } from './bot-items-store'
import { firstMessageActsFor } from './bot-request-asker'
import { chatAskersOf, createBotMemoryJournal } from './bot-memory-journal-runtime'

const CLOSED = new Date(2026, 10, 21, 15, 0).getTime()
const FILE = join('/home', 'memory', 'journal', '2026-11.md')
const dana = {
  source: 'slack' as const,
  userId: 'U_DANA',
  name: 'Dana',
  place: { kind: 'public_channel' as const, id: 'C1' }
}
const teammate: BotRequestAsker = {
  kind: 'person',
  source: 'slack',
  userId: 'U_EVE',
  name: 'Eve | done',
  workspaceId: 'T1',
  role: 'member'
}

// Unrecorded chats, by their first message as the turn reader reads them.
const firsts = new Map<string, Partial<Extract<AgentJournalItemBody, { kind: 'message' }>>>([
  ['owner-typed', {}],
  ['flaky', {}],
  ['owner-connector', { origin: 'connector', asker: { ...dana, role: 'owner' } }],
  ['teammate-connector', { origin: 'connector', asker: { ...dana, role: 'member' } }]
])
const records = new Map<string, readonly BotRequestAsker[]>([['recorded-teammate', [teammate]]])

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

// An item made in `chatId`, closed by `closer` (default: a bot turn in that same chat).
type Close = string | { chatId: string; closer: BotItemActor }

function journalOver(closes: Close[], unreadable: (root: string) => boolean, now: () => number) {
  const fs = memoryFs()
  const reads: string[] = []
  const retries: (() => void)[] = []
  const chats = closes.map((close) =>
    typeof close === 'string'
      ? { chatId: close, closer: { kind: 'bot' as const, botId: 'b1', chatId: close } }
      : close
  )
  const journal = createBotMemoryJournal({
    bots: () => [makeTestBot({ id: 'b1' })],
    closedItems: async () =>
      chats.map(({ chatId }, index) => ({
        uid: `u${index}`,
        number: 1000 + index,
        title: `Errand of ${chatId}`,
        status: 'done' as const,
        links: [],
        closedAt: CLOSED + index,
        chatId
      })),
    closers: async (uids) =>
      Object.fromEntries(uids.map((uid) => [uid, chats[Number(uid.slice(1))]!.closer])),
    chatAskers: chatAskersOf({
      root: (chatId) => chatId,
      actsFor: (root) => records.get(root),
      firstMessage: async (root) => {
        reads.push(root)
        if (root === 'deleted') {
          throw agentSessionRefusalError('agent_session_identity_required', {
            reason: 'recordMissing'
          })
        }
        if (unreadable(root)) {
          throw new Error('host not ready')
        }
        const body = firsts.get(root)
        const message: AgentJournalRenderItem[] = body
          ? [
              {
                itemId: root,
                revision: 0,
                sequence: 1,
                observedAt: 1,
                body: {
                  kind: 'message',
                  role: 'user',
                  blocks: [{ type: 'text', text: root }],
                  ...body
                }
              }
            ]
          : []
        return firstMessageActsFor(message, {
          botRequestAskers: () => null,
          conversationWorkspaceId: null
        })
      }
    }),
    folder: () => '/home',
    serialize: async (_botId, step) => step(),
    fs,
    now,
    later: (step) => retries.push(step)
  })
  const pass = async () => {
    journal.itemsChanged(['b1'])
    await journal.settled()
    return fs.files.get(FILE)
  }
  // Fires the retry a failed read scheduled, and returns the journal once it settles.
  const retry = async () => {
    retries.splice(0).forEach((step) => step())
    await journal.settled()
    return fs.files.get(FILE)
  }
  return { pass, reads, retry }
}

describe("the journal's attribution of each close", () => {
  it("labels a close from a teammate's or an unknown chat, and keeps the owner's lines as they were", async () => {
    const { pass, reads } = journalOver(
      [
        'owner-typed',
        'owner-connector',
        'teammate-connector',
        'recorded-teammate',
        'never-messaged',
        'deleted',
        { chatId: 'teammate-connector', closer: { kind: 'owner' } },
        {
          chatId: 'owner-typed',
          closer: { kind: 'bot', botId: 'b1', chatId: 'teammate-connector' }
        }
      ],
      () => false,
      () => CLOSED + 1_000
    )
    const journal = [
      '# Journal 2026-11',
      '- 2026-11-21 | item #1000 | done | Errand of owner-typed',
      '- 2026-11-21 | item #1001 | done | Errand of owner-connector',
      '- 2026-11-21 | item #1002 | done | Errand of teammate-connector | for Dana via Slack, not your owner',
      '- 2026-11-21 | item #1003 | done | Errand of recorded-teammate | for Eve / done via Slack, not your owner',
      '- 2026-11-21 | item #1004 | done | Errand of never-messaged | asker unknown, not known to be your owner',
      '- 2026-11-21 | item #1005 | done | Errand of deleted | asker unknown, not known to be your owner',
      '- 2026-11-21 | item #1006 | done | Errand of teammate-connector',
      '- 2026-11-21 | item #1007 | done | Errand of owner-typed | for Dana via Slack, not your owner',
      ''
    ].join('\n')
    expect(await pass()).toBe(journal)
    // A pass with no new close reads no chat again.
    const read = reads.length
    expect(await pass()).toBe(journal)
    expect(reads.length).toBe(read)
  })

  it('journals closes whose chats never read as unknown once they have kept failing, with the rest', async () => {
    let now = CLOSED + 1_000
    const { pass, retry } = journalOver(
      ['owner-typed', 'broken', 'also-broken'],
      (root) => root.includes('broken'),
      () => now
    )
    expect(await pass()).toBeUndefined()
    // Quick notices don't use up the chats' tries.
    expect(await pass()).toBeUndefined()
    now += 60_000
    expect(await retry()).toBeUndefined()
    now += 60_000
    expect(await retry()).toBe(
      '# Journal 2026-11\n' +
        '- 2026-11-21 | item #1000 | done | Errand of owner-typed\n' +
        '- 2026-11-21 | item #1001 | done | Errand of broken | asker unknown, not known to be your owner\n' +
        '- 2026-11-21 | item #1002 | done | Errand of also-broken | asker unknown, not known to be your owner\n'
    )
  })

  it('leaves the startup cutoff and watermark alone when a chat cannot be read, then journals it', async () => {
    let unreadable = true
    // Just inside the first pass's 24h lookback; the retry runs past it.
    let now = CLOSED + 24 * 60 * 60 * 1000 - 1
    const { pass } = journalOver(
      ['owner-typed', 'flaky'],
      (root) => root === 'flaky' && unreadable,
      () => now
    )
    expect(await pass()).toBeUndefined()
    now += 2
    unreadable = false
    expect(await pass()).toBe(
      '# Journal 2026-11\n' +
        '- 2026-11-21 | item #1000 | done | Errand of owner-typed\n' +
        '- 2026-11-21 | item #1001 | done | Errand of flaky\n'
    )
  })

  it('reads who closed an item from its close, not a later reopen', () => {
    const store = BotItemsStore.open(':memory:')
    const home = { kind: 'bot' as const, botId: 'b1', chatId: 'home' }
    const { uid } = store.add(
      {
        ownerBotId: 'b1',
        chatId: 'home',
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      home
    )
    store.close(uid, 'done', undefined, { ...home, chatId: 'dana' })
    store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' })
    expect(store.closeActors([uid, 'none'])).toEqual({ [uid]: { ...home, chatId: 'dana' } })
    store.dispose()
  })
})
