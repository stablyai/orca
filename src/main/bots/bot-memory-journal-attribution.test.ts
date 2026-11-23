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
import { makeTestBot } from './bot.test-fixture'
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
  name: 'Eve',
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

function journalOver(chats: string[], unreadable: () => boolean, now: () => number) {
  const fs = memoryFs()
  const journal = createBotMemoryJournal({
    bots: () => [makeTestBot({ id: 'b1' })],
    closedItems: async () =>
      chats.map((chatId, index) => ({
        number: 1000 + index,
        title: `Errand of ${chatId}`,
        status: 'done' as const,
        links: [],
        closedAt: CLOSED + index,
        chatId
      })),
    chatAskers: chatAskersOf({
      root: (chatId) => chatId,
      actsFor: (root) => records.get(root),
      firstMessage: async (root) => {
        if (root === 'deleted') {
          throw agentSessionRefusalError('agent_session_identity_required', {
            reason: 'recordMissing'
          })
        }
        if (root === 'flaky' && unreadable()) {
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
    now
  })
  const pass = async () => {
    journal.itemsChanged(['b1'])
    await journal.settled()
    return fs.files.get(FILE)
  }
  return { pass }
}

describe("the journal's attribution of each close", () => {
  it("labels a close from a teammate's or an unknown chat, and keeps the owner's lines as they were", async () => {
    const { pass } = journalOver(
      [
        'owner-typed',
        'owner-connector',
        'teammate-connector',
        'recorded-teammate',
        'never-messaged',
        'deleted'
      ],
      () => false,
      () => CLOSED + 1_000
    )
    expect(await pass()).toBe(
      [
        '# Journal 2026-11',
        '- 2026-11-21 | item #1000 | done | Errand of owner-typed',
        '- 2026-11-21 | item #1001 | done | Errand of owner-connector',
        '- 2026-11-21 | item #1002 | done | Errand of teammate-connector | for Dana via Slack, not your owner',
        '- 2026-11-21 | item #1003 | done | Errand of recorded-teammate | for Eve via Slack, not your owner',
        '- 2026-11-21 | item #1004 | done | Errand of never-messaged | asker unknown, not known to be your owner',
        '- 2026-11-21 | item #1005 | done | Errand of deleted | asker unknown, not known to be your owner',
        ''
      ].join('\n')
    )
  })

  it('leaves the startup cutoff and watermark alone when a chat cannot be read, then journals it', async () => {
    let unreadable = true
    // Just inside the first pass's 24h lookback; the retry runs past it.
    let now = CLOSED + 24 * 60 * 60 * 1000 - 1
    const { pass } = journalOver(
      ['owner-typed', 'flaky'],
      () => unreadable,
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
})
