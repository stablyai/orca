import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { BotChatRow } from '../../../../../shared/bots/bot-chat-row'
import type { BotRequestAsker } from '../../../../../shared/bots/bot-acts-for'
import { makeTestBot } from '../../../../bots/bot.test-fixture'
import { targetInCallerChat } from './runs-in-caller-chat'
import {
  AutomationCreate,
  AutomationUpdate
} from '../../../../../shared/rpc-contract/automations/automation-params'

const bot = makeTestBot()
const other = makeTestBot({ id: 'other-bot' })
const sessions = new Map<string, typeof bot>()
let rows: BotChatRow[] = []
const askers = new Map<string, BotRequestAsker[]>()

vi.mock('../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) => sessions.get(sessionId) ?? null
}))
vi.mock('../orchestration/messaging/bot-recipient', () => ({
  readBotTurn: async (_runtime: unknown, _db: unknown, sessionId: string) => ({
    turn: { askers: askers.get(sessionId) ?? [] },
    actsFor: [{ kind: 'owner' }]
  })
}))
vi.mock('../bots-chats', () => ({
  readBotChats: async (_runtime: unknown, _bot: unknown, caller: string | null) =>
    rows.map((row) => ({ ...row, self: row.id === caller }))
}))

function row(id: string, home = false): BotChatRow {
  return {
    id,
    title: null,
    lastActivityAt: 0,
    lastAsked: null,
    lastSaid: null,
    home,
    self: false,
    closed: false
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper's lookups are mocked above.
const runtime = { getOrchestrationDb: () => null } as unknown as Parameters<
  typeof targetInCallerChat
>[0]
const wait: AutomationBotTarget = { botId: bot.id, runsIn: 'chat', resultsTo: 'chat' }

beforeEach(() => {
  sessions.clear()
  sessions.set('side-chat', bot)
  sessions.set('home-chat', bot)
  sessions.set('other-chat', other)
  rows = [row('side-chat'), row('home-chat', true)]
  askers.clear()
})

describe('a wait made from a bot chat', () => {
  it('runs in that chat, and in the Home Chat if the chat is gone when it fires', async () => {
    expect(await targetInCallerChat(runtime, 'side-chat', wait, true)).toEqual({
      ...wait,
      chat: { sessionId: 'side-chat', homeIfGone: true }
    })
  })

  it("keeps the bot's Chat from its Home Chat, another bot's chat, or no chat", async () => {
    expect(await targetInCallerChat(runtime, 'home-chat', wait, true)).toEqual(wait)
    expect(await targetInCallerChat(runtime, 'other-chat', wait, true)).toEqual(wait)
    expect(await targetInCallerChat(runtime, undefined, wait, true)).toEqual(wait)
  })

  it('keeps a chat or a new conversation it was given', async () => {
    const named = { ...wait, chat: { sessionId: 'home-chat' } }
    expect(await targetInCallerChat(runtime, 'side-chat', named, true)).toEqual(named)
    const fresh = { ...wait, runsIn: 'new' as const }
    expect(await targetInCallerChat(runtime, 'side-chat', fresh, true)).toEqual(fresh)
  })
})

describe('a recurring automation made from a bot chat', () => {
  const recurring: AutomationBotTarget = { botId: bot.id, runsIn: 'new', resultsTo: 'chat' }
  const nora: BotRequestAsker = {
    kind: 'person',
    source: 'slack',
    userId: 'U_NORA',
    workspaceId: 'T1',
    role: 'member'
  }

  it("runs in a teammate's chat, so its results reach them there", async () => {
    askers.set('side-chat', [nora])
    expect(await targetInCallerChat(runtime, 'side-chat', recurring, false)).toEqual({
      ...recurring,
      runsIn: 'chat',
      chat: { sessionId: 'side-chat', homeIfGone: true }
    })
  })

  it("keeps a new conversation each run for the owner's, or one that needs a new conversation", async () => {
    expect(await targetInCallerChat(runtime, 'side-chat', recurring, false)).toEqual(recurring)
    askers.set('side-chat', [nora])
    const threaded = { ...recurring, resultsTo: 'thread' as const }
    expect(await targetInCallerChat(runtime, 'side-chat', threaded, false)).toEqual(threaded)
    const ownAgent = { ...recurring, agentSetup: { agent: 'claude' as const } }
    expect(await targetInCallerChat(runtime, 'side-chat', ownAgent, false)).toEqual(ownAgent)
  })
})

describe("a client's own homeIfGone", () => {
  it('is dropped at the RPC boundary on create and update; only the host sets it', () => {
    const bot = {
      botId: 'bot-1',
      runsIn: 'chat',
      resultsTo: 'chat',
      chat: { sessionId: 'side-chat', homeIfGone: true }
    }
    const created = AutomationCreate.parse({
      name: 'PR #851',
      prompt: 'Check it',
      agentId: 'claude',
      bot,
      rrule: 'FREQ=DAILY',
      dtstart: 1
    })
    const updated = AutomationUpdate.parse({ id: 'a1', updates: { bot } })
    expect(created.bot?.chat).toEqual({ sessionId: 'side-chat' })
    expect(updated.updates.bot?.chat).toEqual({ sessionId: 'side-chat' })
  })
})
