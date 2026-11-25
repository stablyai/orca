import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { botActiveWorkSection } from './bot-active-work'
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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-turn-notes-'))
  writeFileSync(join(directory, 'SOUL.md'), '# Bot\n')
  writeFileSync(join(directory, 'MEMORY.md'), '# Memory\n')
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  db.recordBotConversationActsFor(OWNER_CHAT, { actsFor: [...OWNER_ACTS_FOR] })
  // As a teammate's New chat records it (startBotShareSession).
  db.recordBotConversationActsFor(TEAMMATE_CHAT, {
    actsFor: [
      botShareAsker({ kind: 'bot-share', botId: BOT, accountId: 'acct-2', name: 'kim@example.com' })
    ]
  })
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const ownerItem = {
  number: 506,
  title: 'Owner invite delay',
  status: 'needs_you' as const,
  lastActivityAt: NOW - 1_000,
  lastEventId: 'e1',
  snoozedUntil: null,
  links: [],
  wait: null,
  chat: { id: OWNER_CHAT },
  question: { gist: 'Build the email button?' }
}

async function turnText(sessionId: string): Promise<string> {
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads only these item fields
    activeWork: async () => botActiveWorkSection([ownerItem as never], [], { now: NOW }),
    endedTurns: async () => 0
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
    blocks: [{ type: 'text', text: 'hi' }]
  }
  const plan = await context.plan(sessionId, hi, undefined)
  return plan?.text ?? ''
}

it("tells a teammate's turn who asks and gives it none of the owner's work or chats", async () => {
  const teammate = await turnText(TEAMMATE_CHAT)
  expect(teammate).toContain('"kim@example.com"')
  expect(teammate).toContain('not your owner')
  for (const owners of ['Owner invite delay', 'Build the email button?', 'Owner debugging chat']) {
    expect(teammate).not.toContain(owners)
  }

  const owner = await turnText(OWNER_CHAT)
  expect(owner).toContain('Owner invite delay')
  expect(owner).toContain('Owner debugging chat')
  expect(owner).not.toContain('not your owner')
})
