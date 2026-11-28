import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotActiveWork } from './bot-active-work-read'
import type { BotItemRecord } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'
import { localBotHomeFilesystem } from './bot-home'
import { botRecentChatsSection } from './bot-recent-chats'
import { botShareAsker } from './team-share/bot-share-chats'
import { createBotTurnAudience } from './bot-turn-audience'
import { createBotTurnContext } from './bot-turn-context'
import { createBotTurnNotes } from './bot-turn-notes'

const BOT = 'bot-1'
const OWNER_CHAT = '11111111-1111-4111-8111-111111111111'
const TEAMMATE_CHAT = '22222222-2222-4222-8222-222222222222'
const NOW = 1_800_000_000_000

let directory = ''
let db: OrchestrationDb
let items: BotItemsStore

const KIM_SHARE = {
  kind: 'account' as const,
  shareId: 'share-2',
  accountId: 'acct-2',
  email: 'kim@example.com',
  addedAt: 1
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-turn-notes-'))
  writeFileSync(join(directory, 'SOUL.md'), '# Bot\n')
  writeFileSync(join(directory, 'MEMORY.md'), '# Memory\n')
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  db.recordBotConversationActsFor(OWNER_CHAT, { actsFor: [...OWNER_ACTS_FOR] })
  // As a teammate's New chat records it (startBotShareSession).
  db.recordBotConversationActsFor(TEAMMATE_CHAT, {
    actsFor: [
      botShareAsker({ shares: [KIM_SHARE] }, { kind: 'bot-share', botId: BOT, accountId: 'acct-2' })
    ]
  })
  items = BotItemsStore.open(':memory:')
  for (const [chatId, title, actsForAccounts] of [
    [OWNER_CHAT, 'Owner invite delay', null],
    [TEAMMATE_CHAT, 'Teammate report draft', ['acct-2']]
  ] as const) {
    items.add(
      {
        ownerBotId: BOT,
        chatId,
        source: { kind: 'home', title: null },
        actsForAccounts,
        title,
        status: 'working',
        links: []
      },
      { kind: 'bot', botId: BOT, chatId }
    )
  }
})
afterEach(() => {
  items.dispose()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

// The runtime members the live-work read uses: the real item store, and no workers.
const runtime = () =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readBotActiveWork reads only these members
  ({
    botItems: {
      store: () => ({
        list: async (query: Parameters<BotItemsStore['list']>[0]) => items.list(query)
      }),
      views: async (records: BotItemRecord[]) =>
        records.map((record) => ({ ...record, links: [], wait: null, chat: { id: record.chatId } }))
    },
    botWork: { list: async () => [] }
  }) as never

async function turnText(
  sessionId: string,
  typedBy?: AgentJournalMessageItem['typedBy']
): Promise<string> {
  const notes = createBotTurnNotes({
    audience: createBotTurnAudience({
      getOrchestrationDb: () => db,
      listAutomationRuns: () => [],
      showAutomation: () => {
        throw new Error('none')
      },
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
    }),
    recentChats: async () =>
      botRecentChatsSection(
        'Bot',
        [
          {
            id: OWNER_CHAT,
            title: 'Owner debugging chat',
            lastActivityAt: NOW - 60_000,
            lastSaid: 'Owner reply',
            workers: [],
            self: false
          }
        ],
        NOW
      ),
    activeWork: (botId, scope) => readBotActiveWork(runtime(), botId, scope),
    endedTurns: async () => 0,
    bot: () => ({ shares: [KIM_SHARE] })
  })
  const context = createBotTurnContext(
    localBotHomeFilesystem,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    notes.recentChats,
    notes.turnNote
  )
  context.launched(sessionId, BOT, directory, { soul: '# Bot\n', memory: '# Memory\n' }, true, {
    block: '',
    name: 'Bot',
    delivered: true,
    rebuilt: false,
    recorded: null
  })
  const hi: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'hi' }],
    ...(typedBy ? { typedBy } : {})
  }
  const plan = await context.plan(sessionId, hi, undefined)
  return plan?.text ?? ''
}

it("tells a teammate's turn who asks, and lists each person only their own items", async () => {
  const teammate = await turnText(TEAMMATE_CHAT)
  expect(teammate).toContain('"kim@example.com"')
  expect(teammate).toContain('not your owner')
  expect(teammate).toContain('Teammate report draft')
  for (const owners of ['Owner invite delay', 'Owner debugging chat']) {
    expect(teammate).not.toContain(owners)
  }

  const owner = await turnText(OWNER_CHAT)
  expect(owner).toContain('Owner invite delay')
  expect(owner).toContain('Owner debugging chat')
  expect(owner).not.toContain('Teammate report draft')
  expect(owner).not.toContain('not your owner')
})

// Teammates open and reply in anyone's chat: the agent hears who typed each message, as the host
// stamped it, never only whose chat it is.
it('names the typist of a message that is not whom the chat is for', async () => {
  const kim = { by: 'device' as const, deviceId: 'kim-desk', accountId: 'acct-2', own: false }
  const inOwners = await turnText(OWNER_CHAT, kim)
  expect(inOwners).toContain('this message is from "kim@example.com"')
  expect(inOwners).toContain('not your owner')

  // The owner at the host's window, or on a phone or computer of their own account.
  const ownPhone = {
    by: 'device' as const,
    deviceId: 'owner-phone',
    accountId: 'acct-owner',
    own: true
  }
  for (const owner of [{ by: 'host' as const }, ownPhone]) {
    const ownerInKims = await turnText(TEAMMATE_CHAT, owner)
    expect(ownerInKims).toContain('this message is from your owner, in "kim@example.com"\'s chat')
    expect(ownerInKims).not.toContain('Messages here are from')
  }

  // Kim in her own chat, and an unstamped message: the chat's own line, as before.
  expect(await turnText(TEAMMATE_CHAT, kim)).toContain('Messages here are from "kim@example.com"')
  expect(await turnText(OWNER_CHAT)).not.toContain('not your owner')
})
