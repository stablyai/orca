// Whose chat the owner's list says each one is, from Orca's acts-for record alone: a teammate's own
// chat names them, the owner's and an unrecorded (older) chat name no one, and nothing is stored.
import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import type { BotRequestAsker } from '../../../shared/bots/bot-acts-for'
import type { BotChatTreeChat } from '../../../shared/bots/bot-chat-tree'
import { BotChatTreeReadSchema } from '../../../shared/bots/bot-chat-tree-schema'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import { botHomePlaceholderId } from '../../../shared/bots/bot-home-of'
import { botHomeOfChat, botHomesOfChats } from '../bot-conversation-acts-for'
import { withBotChatPeople } from './bot-share-chats'
import { NO_HOME_CHAT_ID } from '../../../shared/bots/bot-chat-tree-model'
import { OWNER_UNMADE_HOME_ID } from '../bot-chat-tree-viewer'

const SHARES: NonNullable<Bot['shares']> = [
  {
    kind: 'account',
    shareId: 's1',
    accountId: 'acc-alice',
    name: 'Alice Park',
    email: 'alice@x.dev',
    addedAt: 1
  },
  { kind: 'account', shareId: 's2', accountId: 'acc-bo', email: 'bo@x.dev', addedAt: 1 },
  { kind: 'invite', shareId: 's3', email: 'eli@x.dev', addedAt: 1 }
]
const orcaPerson = (userId: string): BotRequestAsker => ({
  kind: 'person',
  source: 'orca',
  userId,
  workspaceId: null,
  role: 'member'
})
const RECORDS: Record<string, BotRequestAsker[]> = {
  own: [{ kind: 'owner' }],
  alice: [orcaPerson('acc-alice')],
  // Bo asked in Slack, through the Slack login linked to their Orca account.
  boSlack: [
    {
      kind: 'person',
      source: 'slack',
      userId: 'U_BO',
      workspaceId: 'T1',
      role: 'member',
      viaAccount: 'acc-bo'
    }
  ],
  both: [orcaPerson('acc-alice'), orcaPerson('acc-bo')],
  stranger: [orcaPerson('acc-gone')]
}

// The real database, so the one batched read is the query that runs.
function sources() {
  const db = new OrchestrationDb(':memory:')
  for (const [id, actsFor] of Object.entries(RECORDS)) {
    db.recordBotConversationActsFor(id, { actsFor })
  }
  return {
    getOrchestrationDb: () => db,
    listAutomationRuns: () => [],
    showAutomation: () => {
      throw new Error('gone')
    }
  }
}

const chat = (chatId: string): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: 1,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0
})

describe('whose chat each of the owner’s chats is', () => {
  const ids = ['own', 'alice', 'boSlack', 'both', 'stranger', 'unrecorded']
  const people = (shares: Bot['shares']) =>
    withBotChatPeople(sources(), { shares }, { chats: ids.map(chat) }).chats.map(
      (entry) => entry.person
    )

  it('names a teammate by their share (name, else email), and no one else', () => {
    expect(people(SHARES)).toEqual([
      undefined,
      { accountId: 'acc-alice', name: 'Alice Park' },
      { accountId: 'acc-bo', name: 'bo@x.dev' },
      undefined,
      undefined,
      undefined
    ])
  })

  it('names the person of a Home not made yet, and no one whose share was declined', () => {
    const declined = SHARES.map((share) =>
      share.kind === 'account' && share.accountId === 'acc-alice'
        ? { ...share, declinedAt: 2 }
        : share
    )
    const read = withBotChatPeople(
      sources(),
      { shares: declined },
      {
        chats: [
          chat('alice'),
          chat(botHomePlaceholderId('acc-bo')),
          chat(botHomePlaceholderId('acc-alice'))
        ]
      }
    )
    expect(read.chats.map((entry) => entry.person)).toEqual([
      undefined,
      { accountId: 'acc-bo', name: 'bo@x.dev' },
      undefined
    ])
  })

  it('reads each chat’s id as its viewer has it: their own Home not made yet is theirs', () => {
    const read = withBotChatPeople(
      sources(),
      { shares: SHARES },
      {
        chats: [
          chat(NO_HOME_CHAT_ID),
          chat(OWNER_UNMADE_HOME_ID),
          chat(botHomePlaceholderId('acc-bo'))
        ]
      },
      { accountId: 'acc-alice' }
    )
    expect(read.chats.map((entry) => entry.person)).toEqual([
      { accountId: 'acc-alice', name: 'Alice Park' },
      undefined,
      { accountId: 'acc-bo', name: 'bo@x.dev' }
    ])
  })

  it('answers one chat the way the batched read answers it', () => {
    const src = sources()
    const bot = { shares: SHARES }
    const roots = [...ids, botHomePlaceholderId('acc-bo'), botHomePlaceholderId('acc-gone')]
    const batched = botHomesOfChats(src, bot, roots)
    expect(roots.map((root) => botHomeOfChat(src, bot, root))).toEqual(
      roots.map((root) => batched.get(root))
    )
  })

  it('leaves an unshared bot’s chats as they were', () => {
    const read = { chats: ids.map(chat) }
    expect(withBotChatPeople(sources(), { shares: [] }, read)).toBe(read)
  })

  it('reads a host’s chat from before people were named, and keeps the name from a newer one', () => {
    const parsed = BotChatTreeReadSchema.parse({
      chats: [
        chat('old'),
        { ...chat('new'), person: { accountId: 'acc-alice', name: 'Alice Park' } }
      ],
      workspaceChats: {}
    })
    expect(parsed.chats.map((entry) => entry.person)).toEqual([
      undefined,
      { accountId: 'acc-alice', name: 'Alice Park' }
    ])
  })
})
