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
import { botChatTreeForViewer, OWNER_UNMADE_HOME_ID } from './bot-chat-tree-viewer'
import {
  botSidebarListedChats,
  withViewerChatTabs
} from '../../shared/bots/bot-sidebar-chat-groups'

const ALICE = 'acct-alice'
const ALICE_TOO = 'acct-alice-2'

const aliceShare = (accountId: string) => ({
  kind: 'account' as const,
  shareId: `share-${accountId}`,
  accountId,
  name: 'Alice',
  email: 'alice@example.com',
  addedAt: 1
})
const bot = { shares: [aliceShare(ALICE), aliceShare(ALICE_TOO)] }
const owner = { bot, person: 'owner' as const }
const viewerAlice = { bot, person: { accountId: ALICE }, ownerName: 'Jin' }

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

  it('gives Alice exactly one Home row, hers, and every other chat of the agent', () => {
    const { alice } = trees(made)
    const [home] = homes(alice)
    expect(homes(alice)).toHaveLength(1)
    expect(home).toMatchObject({
      chatId: made ? 'alice-home' : NO_HOME_CHAT_ID,
      title: HOME_CHAT_TITLE
    })
    expect(home.homeOf).toBeUndefined()
    expect(home.running.map((worker) => worker.key)).toEqual(['worker:d-alice'])
    // The owner's Home lists by the owner's name; the owner's work stays under it.
    expect(alice.chats.find((entry) => entry.chatId === 'owner-home')).toMatchObject({
      origin: 'side',
      homeOf: 'Jin',
      title: 'Jin’s Home'
    })
    expect(alice.workspaceChats).toMatchObject({
      'wt-alice': home.chatId,
      'wt-owner': 'owner-side',
      'wt-handed': 'owner-home'
    })
    expect(alice.chats.map((entry) => entry.chatId).sort()).toEqual(
      [home.chatId, 'alice-side', 'alice2-home', 'owner-home', 'owner-side'].sort()
    )
  })

  it('never gives a teammate the owner’s read marks or tabs', () => {
    const { alice } = trees(made)
    expect(alice.chats.every((entry) => !entry.unread && entry.tab === undefined)).toBe(true)
    expect(alice.chats.some((entry) => entry.unseen)).toBe(false)
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
    expect(alice.chats.map((entry) => entry.chatId)).toEqual(['owner-side'])
    expect(owner.chats.map((entry) => entry.chatId)).toEqual(['owner-side'])
  })
})

describe('two teammates both named Alice', () => {
  it('match by account, so each has only their own Home as Home', () => {
    const { alice, owner } = trees(true)
    expect(homes(alice).map((entry) => entry.chatId)).toEqual(['alice-home'])
    expect(alice.chats.find((entry) => entry.chatId === 'alice2-home')).toMatchObject({
      origin: 'side',
      homeOf: 'Alice'
    })
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
    expect(alice.chats.map((entry) => entry.tab)).toEqual([undefined, undefined, undefined])

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

describe.each([true, false])('the owner’s Home not made yet (Alice’s made: %s)', (made) => {
  function unmadeOwnerHome(ownerWork: boolean) {
    const chats = [
      ...(made
        ? [chat('alice-home', { title: 'Alice’s Home', whoseHome: { accountId: ALICE } })]
        : []),
      chat('alice-side', { closed: true })
    ]
    const host = buildBotChatTree({
      chats,
      placed: placeBotChatDispatches(
        chats,
        [dispatch('d-alice', 'alice-side', 'wt-alice')],
        homeOfChat
      ),
      workers: new Map(),
      extras: ownerWork
        ? [
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
          ]
        : []
    })
    return botChatTreeForViewer(host, viewerAlice, { page: false })
  }

  it('is never a teammate’s Home row, and lists by the owner’s name only while work runs under it', () => {
    for (const ownerWork of [false, true]) {
      const alice = unmadeOwnerHome(ownerWork)
      const ids = alice.chats.map((entry) => entry.chatId)
      expect(new Set(ids).size).toBe(ids.length)
      expect(homes(alice).map((entry) => [entry.chatId, entry.running.map((w) => w.key)])).toEqual([
        [made ? 'alice-home' : NO_HOME_CHAT_ID, ['worker:d-alice']]
      ])
      const owners = alice.chats.find((entry) => entry.chatId === OWNER_UNMADE_HOME_ID)
      if (!ownerWork) {
        expect(owners).toBeUndefined()
        expect(alice.workspaceChats['wt-handed']).toBeUndefined()
        continue
      }
      expect(owners).toMatchObject({ origin: 'side', homeOf: 'Jin', title: 'Jin’s Home' })
      expect(alice.workspaceChats['wt-handed']).toBe(OWNER_UNMADE_HOME_ID)
    }
  })
})
