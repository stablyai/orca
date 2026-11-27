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
import { refreshSharePersonNames } from './team-share/share-person-name-sync'
import { provideTeammateHomeBots } from '../runtime/agent-session/records/agent-session-record-home-names'
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
    provideTeammateHomeBots(null)
    await rig?.dispose()
    rig = undefined
  })

  /** `aliceHomeName`: what an older build saved on Alice's Home; null for none, as this one saves. */
  async function setup(aliceHomeName: string | null = null) {
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
    if (aliceHomeName) {
      await host.setUserConversationName(ALICE_HOME, aliceHomeName, 'rename')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Home owner reads only these fields.
    let bot = {
      id: 'bot-1',
      agent: 'codex',
      chatSessionId: HOST_TEST_SESSION,
      folderWorkspaceId: 'home',
      shares: [share(ALICE.accountId, 'Alice', ALICE_HOME), share(BO.accountId, 'Bo', BO_HOME)]
    } as Bot
    // The runtime's bots, whose share rows the record store titles teammates' Homes by.
    provideTeammateHomeBots(() => [bot])
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
    // The new Home is stored unnamed and read as hers; the one it replaced is an ordinary chat.
    expect(raw(next)?.conversationName).toBeUndefined()
    expect(rig!.store.getConversation(next)?.conversationName).toBe('Alice’s Home')
    expect(rig!.store.getConversation(ALICE_HOME)?.conversationName).not.toBe('Alice’s Home')
  })

  // The record as stored, not as reads title it.
  const raw = (sessionId: string) => {
    const selected = rig!.store.selectWritableRecord(sessionId)
    return selected.kind === 'writable' ? selected.record : null
  }
  // The cloud's share_resolved for Alice, carrying `name`, as the connector hands it over.
  const nameArrives = async (
    bots: {
      list: () => Bot[]
      update: (id: string, edit: (saved: Bot) => Partial<Bot>) => Promise<void>
    },
    name: string,
    refresh: (workspaceId: string, sessionId: string) => void = () => {}
  ) => {
    const before = bots.list()[0]
    const delivery: Parameters<typeof resolveBotShareInvite>[1] = {
      kind: 'share_resolved',
      deliveryId: `share-named:${name}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      conversation: { source: 'orca', externalId: 'share-Alice' },
      shareId: 'share-Alice',
      botId: 'bot-1',
      email: 'alice@example.com',
      accountId: ALICE.accountId,
      name
    }
    expect(await resolveBotShareInvite(bots, delivery)).toBe(true)
    await refreshSharePersonNames(
      { bots, botShareDevices: null, refreshStructuredConversationTabTitle: refresh },
      'bot-1',
      before
    )
  }
  const unnamed = async (bots: Parameters<typeof nameArrives>[0]) =>
    bots.update('bot-1', (saved) => ({
      shares: saved.shares?.map((entry) =>
        entry.kind === 'account' && entry.accountId === ALICE.accountId
          ? { ...entry, name: undefined }
          : entry
      )
    }))
  // What every reader shows the owner for Alice's Home: records (Items, chat lists, tab titles), the
  // host's naming feed (tab switcher, Cmd+K, the board, usage-limit stops), the agent row's line and
  // search.
  const shown = async (bot: () => Bot) => {
    const feed = structuredAgentSessionNamingSnapshot(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the naming snapshot reads only these two.
      {
        getConversation: (id: string) => rig!.store.getConversation(id),
        listConversations: () => rig!.store.listConversations()
      } as never
    )
    const feedName =
      feed.type === 'snapshot'
        ? feed.conversationNames?.find((entry) => entry.sessionId === ALICE_HOME)?.conversationName
        : undefined
    const directory = mkdtempSync(join(tmpdir(), 'teammate-home-names-'))
    const db = new OrchestrationDb(join(directory, 'orchestration.db'))
    try {
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
      const line = (await readBotOwnChatPanes(treeHost))['bot-1']?.map((chat) => chat.title)
      const found = await searchBotChats(
        {
          ...treeHost,
          treeParts: (botId) => readBotChatTreeParts(treeHost, { botId }),
          contentMatches: async () => []
        },
        { botId: 'bot-1', query: 'alice' }
      )
      return {
        record: rig!.store.getRecord(ALICE_HOME)?.conversationName,
        listed: rig!.store.listRecords().find((entry) => entry.sessionId === ALICE_HOME)
          ?.conversationName,
        feed: feedName,
        line,
        search: found.chats.find((chat) => chat.chatId === ALICE_HOME)?.title
      }
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const everywhere = (name: string) => ({
    record: name,
    listed: name,
    feed: name,
    line: expect.arrayContaining([name]),
    search: name
  })

  it('shows an older build’s email-named Home by the name that arrives, writing nothing', async () => {
    const { bot, bots } = await setup('alice@example.com’s Home')
    await unnamed(bots)
    expect(await shown(bot)).toEqual(everywhere('alice@example.com’s Home'))
    const stored = raw(ALICE_HOME)
    await nameArrives(bots, 'Alice Lee')
    expect(await shown(bot)).toEqual(everywhere('Alice Lee’s Home'))
    // The same stored row, untouched: nothing was written, so a quit mid-update loses nothing.
    expect(raw(ALICE_HOME)).toBe(stored)
  })

  it('shows a rename from Alice to Alice Lee everywhere, with the chat host closed or open', async () => {
    const { bot, bots, host } = await setup()
    expect(await shown(bot)).toEqual(everywhere('Alice’s Home'))
    // Closed: nothing to tell; the next read is already right.
    await nameArrives(bots, 'Alice Lee')
    expect(await shown(bot)).toEqual(everywhere('Alice Lee’s Home'))
    // Open: what is showing the Home hears of it, from memory alone.
    setStructuredAgentSessionHost(host)
    const published = vi.spyOn(host, 'publishConversationName').mockImplementation(() => {})
    const retitled = vi.fn()
    await nameArrives(bots, 'Alice Kim', retitled)
    expect(published).toHaveBeenCalledWith(ALICE_HOME)
    expect(retitled).toHaveBeenCalledWith('folder:home', ALICE_HOME)
    expect(await shown(bot)).toEqual(everywhere('Alice Kim’s Home'))
    // Bot Items' chat title reads the installed host's records.
    expect(readAgentSessionRecordStore()?.getRecord(ALICE_HOME)?.conversationName).toBe(
      'Alice Kim’s Home'
    )
    expect(raw(ALICE_HOME)?.conversationName).toBeUndefined()
  })

  it('keeps a name the owner gave the Home, and never names it from its content', async () => {
    const { bot, bots, host } = await setup()
    expect(
      await rig!.store.compareAndSetConversationName(ALICE_HOME, 'Fix the build', null)
    ).toBeNull()
    expect(raw(ALICE_HOME)?.conversationName).toBeUndefined()
    await host.setUserConversationName(ALICE_HOME, 'Pairing with Alice', 'rename')
    await nameArrives(bots, 'Alice Lee')
    expect(await shown(bot)).toEqual(everywhere('Pairing with Alice'))
    expect(
      botShareAsker(bot(), { kind: 'bot-share', botId: 'bot-1', accountId: ALICE.accountId })
    ).toMatchObject({ name: 'Alice Lee' })
  })

  it('a replaced Home gives up the name an older build saved by email', async () => {
    const { chats, bots } = await setup('alice@example.com’s Home')
    await nameArrives(bots, 'Alice Lee')
    const next = await chats.reset('bot-1', ALICE)
    expect(rig!.store.getConversation(next)?.conversationName).toBe('Alice Lee’s Home')
    expect(raw(ALICE_HOME)?.conversationName).toBeUndefined()
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
