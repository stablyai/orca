import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import {
  botHome,
  botHomeOfSession,
  withBotHome,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  conversationRecordReader,
  readAgentSessionRecordStore
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { readBotOwnChatPanes } from './bot-own-chat-panes'
import { searchBotChats } from './bot-chat-search-host'
import { readBotChatTreeParts, type BotChatTreeHost } from './bot-chat-tree-host'
import { syncSharePersonNames } from './team-share/share-person-name-sync'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredAgentSessionNamingSnapshot } from '../native-chat/agent-session-wire/observations/structured-agent-session-status-feed-deps'
import { resolveBotShareInvite } from './bot-team-share-deliveries'
import { botShareAsker } from './team-share/bot-share-chats'
import { isBotHomeTab } from '../../shared/bots/bot-home-tab'
import { botShareListedBots } from './team-share/bot-share-access'
import type { BotAccountShare } from '../../shared/bots/bot-team-shares'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { newHomeChatOf } from '../runtime/rpc/methods/bots-caller-home'
import { botChatSessions } from './bot-chat-session'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'

const ALICE = { accountId: 'acct-alice' }
const BO = { accountId: 'acct-bo' }
const ALICE_HOME = '00000000-0000-4000-8000-00000000a11c'
const BO_HOME = 'bo-home'

function share(accountId: string, name: string, homeSessionId: string): BotAccountShare {
  return {
    kind: 'account',
    shareId: `share-${name}`,
    accountId,
    name,
    email: `${name.toLowerCase()}@example.com`,
    addedAt: 1,
    acceptedAt: 2,
    homeSessionId
  }
}

describe('a Home Chat for each person', () => {
  let rig: QueuedMessageTestRig | undefined
  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    await rig?.dispose()
    rig = undefined
  })

  async function setup(aliceHomeName = 'Alice’s Home') {
    rig = await createQueuedMessageTestRig()
    const current = rig
    // The rig's host names nothing; names go through the record store's own write rule.
    const host: StructuredAgentSessionHost = Object.create(current.host)
    host.setUserConversationName = async (sessionId, name, write) => {
      await current.store.setUserConversationName(sessionId, name, write)
      return null
    }
    const attach = async (sessionId: string) => {
      const attached = await current.host.attach(
        QUEUED_RIG_CALLER,
        hostTestAttachParams(null, {
          envelope: {
            sessionId,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          },
          providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` },
          // In the agent's home, as its chats are.
          location: { ...HOST_TEST_LOCATION, workspaceId: 'folder:home', workspaceKind: 'folder' }
        })
      )
      expect(attached).toMatchObject({ ok: true })
    }
    await attach(ALICE_HOME)
    await host.setUserConversationName(ALICE_HOME, aliceHomeName, 'rename')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Home owner reads only these fields.
    let bot = {
      id: 'bot-1',
      agent: 'codex',
      chatSessionId: HOST_TEST_SESSION,
      folderWorkspaceId: 'home',
      shares: [share(ALICE.accountId, 'Alice', ALICE_HOME), share(BO.accountId, 'Bo', BO_HOME)]
    } as Bot
    const created: { sessionId: string; of: BotHomeOf }[] = []
    const showTab = vi.fn(async () => {})
    const chats = botChatSessions({
      bots: {
        list: () => [bot],
        setHome: async (_id, of, sessionId) => {
          bot = { ...bot, ...withBotHome(bot, of, sessionId) }
          return bot
        }
      },
      host: async () => host,
      createChat: async (_bot, sessionId, of) => {
        created.push({ sessionId, of })
        await attach(sessionId)
      },
      showTab,
      closeChat: async (sessionId) => {
        await current.host.close(sessionId, 'user-close')
        return { stopped: true }
      },
      dropUnreadMail: async () => {}
    })
    return {
      chats,
      host,
      created,
      showTab,
      bot: () => bot,
      // BotController.update, as share deliveries write through it.
      bots: {
        list: () => [bot],
        update: async (
          _id: string,
          edit: (saved: Bot) => Partial<Pick<Bot, 'shares'>>
        ): Promise<void> => {
          bot = { ...bot, ...edit(bot) }
        }
      },
      remove: (accountId: string) => {
        bot = {
          ...bot,
          shares: bot.shares?.filter(
            (entry) => entry.kind !== 'account' || entry.accountId !== accountId
          )
        }
      }
    }
  }

  it('resets only that person’s Home, leaving the owner’s and other teammates’ pointers as they were', async () => {
    const { chats, created, showTab, bot } = await setup()
    const before = JSON.stringify({ owner: bot().chatSessionId, bo: botHome(bot(), BO) })
    const next = await chats.reset('bot-1', ALICE)
    expect(next).not.toBe(ALICE_HOME)
    expect(botHome(bot(), ALICE)).toBe(next)
    expect(JSON.stringify({ owner: bot().chatSessionId, bo: botHome(bot(), BO) })).toBe(before)
    expect(created).toEqual([{ sessionId: next, of: ALICE }])
    // A teammate's Home is a side-chat tab on the owner's computer: nothing reopens it.
    expect(showTab).not.toHaveBeenCalled()
    // The new Home bears her Home's name; the one it replaced gives it up.
    expect(rig!.store.getConversation(next)?.conversationName).toBe('Alice’s Home')
    expect(rig!.store.getConversation(ALICE_HOME)?.conversationName).not.toBe('Alice’s Home')
  })

  // Named by her email before her name reached the host (as an older build did too), or by the name
  // she had before she changed it.
  it.each([
    { saved: 'alice@example.com’s Home', had: undefined },
    { saved: 'Alice’s Home', had: 'Alice' }
  ])(
    'renames "$saved" for every reader once a new name reaches the host, chat host not open yet',
    async ({ saved, had }) => {
      const { bot, bots, host } = await setup(saved)
      await bots.update('bot-1', (stored) => ({
        shares: stored.shares?.map((entry) =>
          entry.kind === 'account' && entry.accountId === ALICE.accountId
            ? { ...entry, name: had }
            : entry
        )
      }))
      // The chat host installs lazily: nothing has opened it when the delivery lands.
      setStructuredAgentSessionHost(null)
      const ensureStructuredAgentSessionHost = vi.fn(async () => {
        setStructuredAgentSessionHost(host)
      })
      const syncDevices = vi.fn(async () => {})
      // As the connector's share_resolved handler runs it.
      const before = bot()
      const named: Parameters<typeof resolveBotShareInvite>[1] = {
        kind: 'share_resolved',
        deliveryId: 'share-named:1',
        expiresAt: Number.MAX_SAFE_INTEGER,
        conversation: { source: 'orca', externalId: 'share-Alice' },
        shareId: 'share-Alice',
        botId: 'bot-1',
        email: 'alice@example.com',
        accountId: ALICE.accountId,
        name: 'Alice Lee'
      }
      expect(await resolveBotShareInvite(bots, named)).toBe(true)
      await syncSharePersonNames(
        {
          bots: { list: () => [bot()] },
          botShareDevices: { syncBotShareDeviceNames: syncDevices },
          ensureStructuredAgentSessionHost
        },
        'bot-1',
        before
      )
      expect(syncDevices).toHaveBeenCalledOnce()
      expect(ensureStructuredAgentSessionHost).toHaveBeenCalledOnce()
      // Bot Items' chat title: the record's name.
      expect(readAgentSessionRecordStore()?.getRecord(ALICE_HOME)?.conversationName).toBe(
        'Alice Lee’s Home'
      )
      // The host's naming feed, which the tab switcher, Cmd+K, the board and usage-limit stops read.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the naming snapshot reads only these two.
      const feed = structuredAgentSessionNamingSnapshot({
        getConversation: (id: string) => rig!.store.getConversation(id),
        listConversations: () => rig!.store.listConversations()
      } as never)
      expect(feed).toMatchObject({
        conversationNames: expect.arrayContaining([
          expect.objectContaining({ sessionId: ALICE_HOME, conversationName: 'Alice Lee’s Home' })
        ])
      })
      expect(
        botShareAsker(bot(), { kind: 'bot-share', botId: 'bot-1', accountId: ALICE.accountId })
      ).toMatchObject({ name: 'Alice Lee' })
      const directory = mkdtempSync(join(tmpdir(), 'teammate-home-names-'))
      const db = new OrchestrationDb(join(directory, 'orchestration.db'))
      try {
        // The owner's chat host as bots.chats.own and bots.chats.search read it.
        const treeHost: BotChatTreeHost = {
          bots: () => [bot()],
          sessionRecords: async () => conversationRecordReader(rig!.store),
          db: () => db,
          backgroundRuns: { botOfLook: () => null, botOfTidyUp: () => null },
          externalConversations: () => [],
          chatTabs: async () => [],
          statusRows: () => [],
          automations: () => [],
          automationRuns: () => new Map(),
          recordedWorkers: async () => [],
          dispatchWorkers: async () => []
        }
        const line = await readBotOwnChatPanes(treeHost)
        expect(line['bot-1']?.map((chat) => chat.title)).toContain('Alice Lee’s Home')
        const found = await searchBotChats(
          {
            ...treeHost,
            treeParts: (botId) => readBotChatTreeParts(treeHost, { botId }),
            contentMatches: async () => []
          },
          { botId: 'bot-1', query: 'Alice Lee' }
        )
        expect(found.chats).toEqual([
          expect.objectContaining({
            chatId: ALICE_HOME,
            title: 'Alice Lee’s Home',
            homeOf: 'Alice Lee'
          })
        ])
      } finally {
        db.close()
        rmSync(directory, { recursive: true, force: true })
      }
      // A name the owner gave it stays theirs.
      await host.setUserConversationName(ALICE_HOME, 'Pairing with Alice', 'rename')
      await syncSharePersonNames(
        { bots: { list: () => [bot()] }, botShareDevices: null, ensureStructuredAgentSessionHost },
        'bot-1',
        before
      )
      expect(rig!.store.getConversation(ALICE_HOME)?.conversationName).toBe('Pairing with Alice')
    }
  )

  it('a replaced Home gives up the name an older build saved by email', async () => {
    const { chats, bots } = await setup('alice@example.com’s Home')
    await bots.update('bot-1', (saved) => ({
      shares: saved.shares?.map((entry) =>
        entry.kind === 'account' && entry.accountId === ALICE.accountId
          ? { ...entry, name: 'Alice Lee' }
          : entry
      )
    }))
    const next = await chats.reset('bot-1', ALICE)
    expect(rig!.store.getConversation(next)?.conversationName).toBe('Alice Lee’s Home')
    expect(rig!.store.getConversation(ALICE_HOME)?.conversationName).not.toBe(
      'alice@example.com’s Home'
    )
  })

  it('opens a teammate’s Home as it is, with no tab shown, and the owner’s with its tab', async () => {
    const { chats, showTab } = await setup()
    expect(await chats.ensure('bot-1', ALICE)).toBe(ALICE_HOME)
    expect(await chats.withChat('bot-1', ALICE, (sessionId) => sessionId)).toBe(ALICE_HOME)
    expect(showTab).not.toHaveBeenCalled()
    expect(await chats.ensure('bot-1', 'owner')).toBe(HOST_TEST_SESSION)
    expect(showTab).toHaveBeenCalledTimes(1)
  })

  it('opens the very id the share projects as their Home, so their tab is the Home tab', async () => {
    const { chats, bot } = await setup()
    // The ids bots.chat.open hands the teammate's tab: on a first open, and after a reset.
    const isTheirHomeTab = (opened: string) => {
      const [projected] = botShareListedBots([bot()], {
        botId: 'bot-1',
        accountId: ALICE.accountId
      })
      expect(projected.chatSessionId).toBe(opened)
      // The tab opened for it is keyed by that id: the pin, accent and banner read it so.
      const tab = { contentType: 'agent-session' as const, entityId: opened }
      expect(isBotHomeTab(tab, projected)).toBe(true)
      expect(botHomeOfSession(projected, opened)).toBe('owner')
    }
    isTheirHomeTab(await chats.withChat('bot-1', ALICE, (sessionId) => sessionId))
    isTheirHomeTab(await chats.reset('bot-1', ALICE))
  })

  it('makes no chat for a removed teammate', async () => {
    const { chats, created, remove } = await setup()
    remove(ALICE.accountId)
    await expect(chats.reset('bot-1', ALICE)).rejects.toThrow('bot_not_shared')
    await expect(chats.ensure('bot-1', ALICE)).rejects.toThrow('bot_not_shared')
    expect(created).toEqual([])
  })
})

describe('whose Home New Home Chat resets', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the choice reads only these fields.
  const bot = {
    id: 'bot-1',
    chatSessionId: 'owner-home',
    shares: [share(ALICE.accountId, 'Alice', 'alice-home'), share(BO.accountId, 'Bo', 'bo-home')]
  } as Bot
  // `alice-home-2` is her Home continued by /clear; its root is the pointer.
  const rootOf = (id: string) => (id === 'alice-home-2' ? 'alice-home' : id)
  const of = (input: Partial<Parameters<typeof newHomeChatOf>[0]>) =>
    newHomeChatOf({ scope: null, bot, caller: undefined, callerBot: null, rootOf, ...input })

  it('a teammate’s share names their own Home, whatever chat the call names', () => {
    expect(of({ scope: ALICE, caller: 'bo-home', callerBot: bot })).toEqual(ALICE)
    expect(of({ scope: ALICE, caller: 'owner-home', callerBot: bot })).toEqual(ALICE)
  })

  it('the agent resets the Home it runs in, by /clear root, and refuses from any other chat', () => {
    expect(of({ caller: 'alice-home-2', callerBot: bot })).toEqual(ALICE)
    expect(of({ caller: 'owner-home', callerBot: bot })).toBe('owner')
    expect(() => of({ caller: 'alice-side', callerBot: bot })).toThrow('own Home Chat')
    expect(of({})).toBe('owner')
  })
})
