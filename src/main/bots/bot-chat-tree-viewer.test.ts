import { describe, expect, it } from 'vitest'
import type { BotChatTreeRead } from '../../shared/bots/bot-chat-tree'
import {
  buildBotChatTree,
  HOME_CHAT_TITLE,
  NO_HOME_CHAT_ID,
  placeBotChatDispatches,
  type BotChatHostFacts,
  type BotChatTreeDispatch
} from '../../shared/bots/bot-chat-tree-model'
import type { BotHomeOf } from '../../shared/bots/bot-home-of'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { botShareChatFilter } from './team-share/bot-share-chats'
import { botChatTreeForViewer } from './bot-chat-tree-viewer'
import {
  botSidebarListedChats,
  withViewerChatTabs
} from '../../shared/bots/bot-sidebar-chat-groups'

const ALICE = 'acct-alice'
const ALICE_TOO = 'acct-alice-2'
const member = (userId: string) => ({
  kind: 'person' as const,
  source: 'orca' as const,
  userId,
  name: 'Alice',
  workspaceId: null,
  role: 'member' as const
})

// Whom each chat acts for, as Orca recorded it: the real filter reads this.
const ACTS_FOR: Record<string, ReturnType<typeof member>[] | [{ kind: 'owner' }]> = {
  'owner-home': [{ kind: 'owner' }],
  'alice-home': [member(ALICE)],
  'alice2-home': [member(ALICE_TOO)],
  'alice-side': [member(ALICE)],
  'alice-new': [member(ALICE)],
  'owner-side': [{ kind: 'owner' }]
}
const sources = {
  getOrchestrationDb: () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the filter reads only this record.
    ({
      listBotConversationActsFor: (roots: readonly string[]) =>
        new Map(
          roots.flatMap((root) => (ACTS_FOR[root] ? [[root, { actsFor: ACTS_FOR[root] }]] : []))
        )
    }) as unknown as OrchestrationDb,
  listAutomationRuns: () => [],
  showAutomation: () => {
    throw new Error('gone')
  }
}
const viewerAlice = {
  kind: 'teammate' as const,
  accountId: ALICE,
  owns: botShareChatFilter(sources, {
    kind: 'bot-share',
    botId: 'bot-1',
    accountId: ALICE
  })
}
const aliceShare = (accountId: string) => ({
  kind: 'account' as const,
  shareId: `share-${accountId}`,
  accountId,
  name: 'Alice',
  email: 'alice@example.com',
  addedAt: 1
})
const owner = {
  kind: 'owner' as const,
  bot: { shares: [aliceShare(ALICE), aliceShare(ALICE_TOO)] }
}

function chat(chatId: string, fields: Partial<BotChatHostFacts> = {}): BotChatHostFacts {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    ...fields
  }
}
function dispatch(id: string, chatId: string, worktreeId: string): BotChatTreeDispatch {
  return { id, chatId, settled: false, failed: false, at: 5, worktreeId }
}
const homeOfChat = (chatId: string): BotHomeOf =>
  chatId.startsWith('alice-') ? { accountId: ALICE } : 'owner'

/** The host tree, then each viewer's projection, from one set of chats and Dispatches. */
function trees(aliceHomeMade: boolean, page = false) {
  const chats = [
    chat('owner-home', { origin: 'home', title: HOME_CHAT_TITLE, whoseHome: 'owner' }),
    ...(aliceHomeMade
      ? [chat('alice-home', { title: 'Alice’s Home', whoseHome: { accountId: ALICE } })]
      : []),
    chat('alice2-home', { title: 'Alice’s Home', whoseHome: { accountId: ALICE_TOO } }),
    chat('alice-side', { closed: true }),
    chat('owner-side')
  ]
  const placed = placeBotChatDispatches(
    chats,
    [dispatch('d-alice', 'alice-side', 'wt-alice'), dispatch('d-owner', 'owner-side', 'wt-owner')],
    homeOfChat
  )
  const host = buildBotChatTree({
    chats,
    placed,
    workers: new Map(),
    // Owner-only work: a handed-over agent and a workspace handed to the agent.
    extras: [
      {
        worker: {
          key: 'handed',
          title: 'handed',
          state: 'running',
          startedAt: 1,
          worktreeId: 'wt-handed'
        },
        settled: false,
        at: 1
      }
    ],
    homeWorkspaceIds: ['wt-moved-in'],
    ...(page ? { page: { chatId: 'owner-side' } } : {})
  })
  return {
    host,
    alice: botChatTreeForViewer(host, viewerAlice, { page }),
    owner: botChatTreeForViewer(host, owner, { page })
  }
}

const homes = (tree: BotChatTreeRead) => tree.chats.filter((entry) => entry.origin === 'home')
const workerKeys = (tree: BotChatTreeRead, chatId: string) =>
  tree.chats.find((entry) => entry.chatId === chatId)?.running.map((worker) => worker.key) ?? []

describe.each([true, false])('chats tree per viewer (Alice’s Home made: %s)', (made) => {
  it('never puts the owner’s work in a teammate’s Home', () => {
    const { host } = trees(made)
    expect(workerKeys(host, 'owner-home')).toEqual(['handed'])
    expect(host.workspaceChats['wt-handed']).toBe('owner-home')
    expect(host.workspaceChats['wt-moved-in']).toBe('owner-home')
  })

  it('gives Alice exactly one Home row, hers, holding her closed chat’s worker', () => {
    const { alice } = trees(made)
    const [home] = homes(alice)
    expect(homes(alice)).toHaveLength(1)
    expect(home).toMatchObject({
      chatId: made ? 'alice-home' : NO_HOME_CHAT_ID,
      title: HOME_CHAT_TITLE
    })
    expect(home.homeOf).toBeUndefined()
    expect(home.running.map((worker) => worker.key)).toEqual(['worker:d-alice'])
    expect(alice.workspaceChats).toEqual({ 'wt-alice': home.chatId })
    expect(alice.chats.map((entry) => entry.chatId).sort()).toEqual(
      [home.chatId, 'alice-side'].sort()
    )
  })

  it('never shows Alice’s worker under the owner’s Home', () => {
    const { owner } = trees(made)
    expect(workerKeys(owner, 'owner-home')).toEqual(['handed'])
    expect(workerKeys(owner, NO_HOME_CHAT_ID)).toEqual([])
    const aliceRow = owner.chats.find((entry) =>
      entry.running.some((w) => w.key === 'worker:d-alice')
    )
    expect(aliceRow).toMatchObject({ homeOf: 'Alice', title: 'Alice’s Home', origin: 'side' })
  })

  it('a page read adds no row', () => {
    const { alice, owner } = trees(made, true)
    expect(alice.chats).toEqual([])
    expect(owner.chats.map((entry) => entry.chatId)).toEqual(['owner-side'])
  })
})

describe('two teammates both named Alice', () => {
  it('match by account, so each sees only their own Home', () => {
    const { alice, owner } = trees(true)
    expect(homes(alice).map((entry) => entry.chatId)).toEqual(['alice-home'])
    expect(alice.chats.some((entry) => entry.chatId === 'alice2-home')).toBe(false)
    expect(
      owner.chats
        .filter((entry) => entry.homeOf === 'Alice')
        .map((e) => e.chatId)
        .sort()
    ).toEqual(['alice-home', 'alice2-home'])
  })
})

describe('a teammate’s chats on their own sidebar', () => {
  it('list by the tabs on their computer, never the host’s, which has none for them', () => {
    // As the host builds it: the chats Alice started have no tab there; the owner's has one.
    const chats = [
      chat('owner-home', { origin: 'home', title: HOME_CHAT_TITLE, whoseHome: 'owner', tab: true }),
      chat('alice-home', { title: 'Alice’s Home', whoseHome: { accountId: ALICE }, tab: false }),
      chat('alice-new', { tab: false })
    ]
    const host = buildBotChatTree({
      chats,
      placed: placeBotChatDispatches(chats, [], homeOfChat),
      workers: new Map()
    })
    const alice = botChatTreeForViewer(host, viewerAlice, { page: false })
    expect(alice.chats.map((entry) => entry.tab)).toEqual([undefined, undefined])

    const listed = botSidebarListedChats(
      withViewerChatTabs(alice.chats, new Set(['alice-home', 'alice-new']))
    )
    expect(listed.map((entry) => [entry.chatId, entry.origin])).toEqual([
      ['alice-home', 'home'],
      ['alice-new', 'side']
    ])
    expect(
      botSidebarListedChats(withViewerChatTabs(alice.chats, new Set(['alice-home']))).map(
        (entry) => entry.chatId
      )
    ).toEqual(['alice-home'])
  })

  it('list Home always, owned or shared, made yet or not; other chats only with a tab', () => {
    // Alice's Home not made yet (her placeholder row), and no tab of anything on her computer.
    const { alice, owner } = trees(false)
    expect(
      botSidebarListedChats(withViewerChatTabs(alice.chats, new Set())).map((e) => e.chatId)
    ).toEqual([NO_HOME_CHAT_ID])
    // The owner's own agent: its Home lists with its tab closed, a side chat with no tab does not.
    const ownerChats = owner.chats.map((entry) => ({ ...entry, tab: false }))
    expect(botSidebarListedChats(ownerChats).map((e) => e.chatId)).toEqual(['owner-home'])
  })
})
