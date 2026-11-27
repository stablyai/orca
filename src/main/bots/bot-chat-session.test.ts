import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import {
  botHome,
  botHomeOfSession,
  botHomeTitleOf,
  botSharePersonName,
  withBotHome,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'
import { buildBotChatTree } from '../../shared/bots/bot-chat-tree-model'
import { botChatTreeForViewer } from './bot-chat-tree-viewer'
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
    await rig?.dispose()
    rig = undefined
  })

  async function setup() {
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
          providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
        })
      )
      expect(attached).toMatchObject({ ok: true })
    }
    await attach(ALICE_HOME)
    await host.setUserConversationName(ALICE_HOME, 'Alice’s Home', 'rename')
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
    // The new Home is named Home; the one it replaced (named as older builds did) gives its name up.
    expect(rig!.store.getConversation(next)?.conversationName).toBe('Home')
    expect(rig!.store.getConversation(ALICE_HOME)?.conversationName).not.toBe('Alice’s Home')
  })

  it('titles a teammate’s Home by the name that reaches their share after it was made', async () => {
    const { chats, bot, bots } = await setup()
    // Accepted before their name reached the host: the share has only their email.
    await bots.update('bot-1', (saved) => ({
      shares: saved.shares?.map((entry) =>
        entry.kind === 'account' && entry.accountId === ALICE.accountId
          ? { ...entry, name: undefined }
          : entry
      )
    }))
    const home = await chats.reset('bot-1', ALICE)
    // As the cloud sends it once the teammate's Orca reads its shares.
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
    // No record keeps a copy of who it is for.
    expect(rig!.store.getConversation(home)?.conversationName).toBe('Home')
    // The tab title, the owner's chats list and the asker a new chat records all read it now.
    expect(botHomeTitleOf(bot(), home)).toEqual({ kind: 'teammate', name: 'Alice Lee' })
    const tree = buildBotChatTree({
      chats: [
        {
          chatId: home,
          title: rig!.store.getConversation(home)?.conversationName ?? '',
          origin: 'side',
          live: 'idle',
          lastActiveAt: 1,
          unread: false,
          closed: false,
          whoseHome: ALICE
        }
      ],
      placed: [],
      workers: new Map(),
      extras: [],
      homeWorkspaceIds: []
    })
    const ownerTree = botChatTreeForViewer(
      tree,
      { kind: 'owner', personName: (accountId) => botSharePersonName(bot(), accountId) },
      { page: false }
    )
    expect(ownerTree.chats.find((entry) => entry.chatId === home)).toMatchObject({
      homeOf: 'Alice Lee',
      title: 'Alice Lee’s Home'
    })
    expect(
      botShareAsker(bot(), { kind: 'bot-share', botId: 'bot-1', accountId: ALICE.accountId })
    ).toMatchObject({ name: 'Alice Lee' })
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
