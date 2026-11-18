import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import {
  BOT_CREATED_KICKOFF,
  botMessageBody,
  botChatSessions,
  botWorkspaceSelector,
  type BotChatHost
} from './bot-chat-session'
import { botStartOptions } from './bot-start-options'
import { BOT_CHAT_NAME, releaseReplacedHomes, type BotHomeHost } from './bot-home-chat-name'

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-1',
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

type FakeChat = {
  sessionId: string
  provider: Bot['agent']
  location: { workspaceId: string }
  conversationName?: string
  conversationNameSource?: 'user'
  /** What naming would call it from its first message. */
  content?: string
  visible: boolean
}

function setup(initial: Bot = makeBot()) {
  let bot = initial
  // Chats the host knows, by session id: the provider each runs, its name, and whether its tab shows.
  const records = new Map<string, FakeChat>()
  const host = {
    send: vi.fn(async () => ({
      ok: true as const,
      value: { clientMessageId: 'm1', queued: { position: 1 } }
    })),
    waitForSendSettlement: vi.fn(),
    // As naming does: 'release' drops the name, and the chat is named again from its content.
    setUserConversationName: vi.fn(async (sessionId: string, name: string, write: string) => {
      const chat = records.get(sessionId)!
      if (write !== 'release') {
        Object.assign(chat, { conversationName: name, conversationNameSource: 'user' })
      } else if (chat.conversationName === name && chat.conversationNameSource === 'user') {
        Object.assign(chat, { conversationName: chat.content, conversationNameSource: undefined })
      }
      return null
    }),
    isSessionTabVisible: (sessionId: string) => records.get(sessionId)?.visible ?? false,
    setSessionTabVisibility: vi.fn(async (sessionId: string, visible: boolean) => {
      records.get(sessionId)!.visible = visible
    }),
    deps: {
      store: {
        getConversation: (sessionId: string) => records.get(sessionId) ?? null,
        listConversations: () => [...records.values()],
        lineageRevision: () => records,
        requireWritableRecord: () => ({ lease: { runtimeFence: 7 } })
      }
    }
  }
  const createChat = vi.fn(async (forBot: Bot, sessionId: string) => {
    records.set(sessionId, {
      sessionId,
      provider: forBot.agent,
      location: { workspaceId: folderWorkspaceKey(forBot.folderWorkspaceId) },
      visible: true
    })
  })
  const closeChat = vi.fn(
    async (_sessionId: string): Promise<{ stopped: boolean; reason?: string }> => ({
      stopped: true
    })
  )
  const showTab = vi.fn(async () => undefined)
  const chats = botChatSessions({
    bots: {
      list: () => [bot],
      setChatSession: vi.fn(async (_botId: string, chatSessionId: string) => {
        bot = { ...bot, chatSessionId }
        return bot
      })
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every host member the Chat reads; record reads return only the fields it uses.
    host: async () => host as unknown as BotChatHost,
    createChat,
    showTab,
    closeChat
  })
  return {
    chats,
    host,
    createChat,
    showTab,
    closeChat,
    records,
    bot: () => bot,
    setBot: (next: Bot) => (bot = next)
  }
}

describe('bot Chat', () => {
  it('creates the Chat once, names it, and keeps it on the bot', async () => {
    const { chats, host, createChat, bot } = setup()

    const [first, second] = await Promise.all([chats.ensure('bot-1'), chats.ensure('bot-1')])

    expect(second).toBe(first)
    expect(createChat).toHaveBeenCalledTimes(1)
    expect(createChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), first)
    expect(host.setUserConversationName).toHaveBeenCalledWith(first, BOT_CHAT_NAME, 'rename')
    expect(bot().chatSessionId).toBe(first)
  })

  it('resumes the saved Chat after a restart', async () => {
    const { chats, createChat, showTab, records } = setup(makeBot({ chatSessionId: 'saved-chat' }))
    records.set('saved-chat', {
      sessionId: 'saved-chat',
      provider: 'claude',
      location: { workspaceId: folderWorkspaceKey('fw-1') },
      visible: true
    })

    expect(await chats.ensure('bot-1')).toBe('saved-chat')
    expect(createChat).not.toHaveBeenCalled()
    expect(showTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), 'saved-chat')
  })

  it('starts a new Chat when the saved one is gone or runs another agent', async () => {
    const { chats, closeChat, setBot, bot } = setup(makeBot({ chatSessionId: 'gone' }))
    const replaced = await chats.ensure('bot-1')
    expect(replaced).not.toBe('gone')

    expect(closeChat).not.toHaveBeenCalled()

    setBot({ ...bot(), agent: 'codex' })
    expect(await chats.ensure('bot-1')).not.toBe(replaced)
    expect(closeChat).toHaveBeenCalledWith(replaced)
  })

  it('keeps one Home across two agent switches; each replaced one becomes an ordinary closed chat', async () => {
    const { chats, records, setBot, bot } = setup()
    const first = await chats.ensure('bot-1')
    records.get(first)!.content = 'Why does the app beachball?'

    setBot({ ...bot(), agent: 'codex' })
    const second = await chats.ensure('bot-1')
    records.get(second)!.content = 'Set up the stall monitor'
    // The stop won, but its tab bookkeeping lost a race: restore would reopen a still-listed tab.
    records.get(second)!.visible = true
    setBot({ ...bot(), agent: 'claude' })
    const third = await chats.ensure('bot-1')

    const homes = [...records.values()].filter((chat) => chat.conversationName === BOT_CHAT_NAME)
    expect(homes.map((chat) => chat.sessionId)).toEqual([third])
    expect(records.get(first)).toMatchObject({
      conversationName: 'Why does the app beachball?',
      visible: false
    })
    expect(records.get(second)).toMatchObject({
      conversationName: 'Set up the stall monitor',
      visible: false
    })
  })

  it('renames a Home replaced before replaced Homes were renamed, but never the Chat', async () => {
    const { host, records, bot } = setup(makeBot({ chatSessionId: 'current' }))
    const home = { workspaceId: folderWorkspaceKey('fw-1') }
    const named = { conversationName: BOT_CHAT_NAME, conversationNameSource: 'user' as const }
    records.set('current', {
      sessionId: 'current',
      provider: 'claude',
      location: home,
      visible: true,
      ...named
    })
    records.set('earlier', {
      sessionId: 'earlier',
      provider: 'claude',
      location: home,
      visible: true,
      content: 'Memory crunch',
      ...named
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every host member the renaming reads.
    await releaseReplacedHomes(host as unknown as BotHomeHost, bot())

    expect(records.get('current')?.conversationName).toBe(BOT_CHAT_NAME)
    expect(records.get('earlier')?.conversationName).toBe('Memory crunch')
  })

  it('keeps the old Chat when it cannot be shown stopped, so a retry still finds it', async () => {
    const { chats, closeChat, createChat, bot } = setup()
    const before = await chats.ensure('bot-1')
    closeChat.mockResolvedValueOnce({ stopped: false, reason: 'still attached' })

    await expect(chats.reset('bot-1')).rejects.toThrow('still attached')

    expect(createChat).toHaveBeenCalledTimes(1)
    expect(bot().chatSessionId).toBe(before)
  })

  it('reset starts a new Chat and closes the old one, keeping its history', async () => {
    const { chats, closeChat, showTab } = setup()
    const before = await chats.ensure('bot-1')

    const after = await chats.reset('bot-1')

    expect(after).not.toBe(before)
    expect(closeChat).toHaveBeenCalledWith(before)
    expect(showTab).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bot-1' }), after)
    expect(await chats.ensure('bot-1')).toBe(after)
  })

  it('sends to the Chat that is current when the send is admitted, never one a reset retired', async () => {
    const { chats, host } = setup()
    const before = await chats.ensure('bot-1')

    const [after] = await Promise.all([chats.reset('bot-1'), chats.sendToChat('bot-1', 'hi')])

    expect(after).not.toBe(before)
    expect(host.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envelope: expect.objectContaining({ sessionId: after }) })
    )
  })

  it('sends into the Chat, queued behind a running turn', async () => {
    const { chats, host } = setup()

    const { sessionId, outcome } = await chats.sendToChat('bot-1', 'hello')

    expect(sessionId).toBe(await chats.ensure('bot-1'))
    expect(outcome.kind).toBe('queued')
    expect(host.send).toHaveBeenCalledWith(
      { callerKey: 'bot-chat:bot-1' },
      expect.objectContaining({
        envelope: expect.objectContaining({ sessionId, expectedRuntimeFence: 7 }),
        delivery: 'queue-if-active',
        personsMessage: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      })
    )
  })

  it("marks Orca's first turn to a new bot as its own, not the person's", async () => {
    const { chats, host } = setup()

    await chats.sendToChat('bot-1', BOT_CREATED_KICKOFF, 'bot-created')

    expect(host.send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ personsMessage: expect.anything() })
    )
    expect(host.send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: { ...botMessageBody(BOT_CREATED_KICKOFF), origin: 'bot-created' }
      })
    )
  })

  it("opens the Chat while a new bot's first turn waits for its agent to start", async () => {
    const { chats, host } = setup()
    let started = (): void => {}
    host.send.mockResolvedValueOnce({
      ok: true as const,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Chat reads only the answer's submission state.
      value: {
        clientMessageId: 'm1',
        submission: { clientMessageId: 'm1', dispatchState: 'pending' }
      } as never
    })
    host.waitForSendSettlement.mockImplementationOnce(
      () => new Promise((resolve) => (started = () => resolve(undefined)))
    )

    const kickoff = chats.sendToChat('bot-1', BOT_CREATED_KICKOFF, 'bot-created')
    const opened = await chats.ensure('bot-1')

    expect(host.waitForSendSettlement).toHaveBeenCalledTimes(1)
    started()
    expect((await kickoff).sessionId).toBe(opened)
  })

  it('refuses an unknown bot', async () => {
    await expect(setup().chats.ensure('nope')).rejects.toThrow('bot_not_found')
  })

  it('addresses the home the way native chat resolves a folder workspace', () => {
    const selector = botWorkspaceSelector(makeBot({ folderWorkspaceId: 'fw-9' }))
    expect(selector.startsWith('id:')).toBe(true)
    expect(parseWorkspaceKey(selector.slice('id:'.length))).toEqual({
      type: 'folder',
      folderWorkspaceId: 'fw-9'
    })
  })
})

describe('what a bot conversation starts on', () => {
  // The owner last picked Opus in some chat; `agents` is their Settings > Agents choice.
  const settings = (agents?: { model?: string; options?: Record<string, string> }) =>
    vi.fn(() => ({
      nativeChatSessionOptions: { claude: { model: 'claude-opus-5-5' } },
      agentLaunchChoices: agents ? { claude: agents } : {}
    }))

  it("puts the bot's own model first, for background work and chats alike", () => {
    const bot = makeBot({
      launch: { model: 'claude-haiku-5-5', options: { effort: 'low' } }
    })
    const owner = settings({ model: 'claude-sonnet-5-5' })

    expect(botStartOptions(owner, bot, true)).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'low'
    })
    expect(botStartOptions(owner, bot, false)).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'low'
    })
  })

  it('starts background work on the Agents default when the bot has no model of its own', () => {
    const owner = settings({
      model: 'claude-haiku-5-5',
      options: { effort: 'high' }
    })

    expect(botStartOptions(owner, makeBot(), true)).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'high'
    })
    expect(
      botStartOptions(owner, makeBot({ launch: { options: { effort: 'low' } } }), true)
    ).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
  })

  it("leaves background work on the agent's own default, never the last chat pick, when neither is set", () => {
    expect(botStartOptions(settings(), makeBot(), true)).toEqual({})
  })

  it('leaves a chat the owner opens to the chat defaults the create resolves', () => {
    const owner = settings({ model: 'claude-haiku-5-5' })

    expect(botStartOptions(owner, makeBot(), false)).toEqual({})
    expect(owner).not.toHaveBeenCalled()
  })
})
