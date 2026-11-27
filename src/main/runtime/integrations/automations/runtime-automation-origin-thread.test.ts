import { describe, expect, it } from 'vitest'
import type {
  Automation,
  AutomationBotTarget
} from '../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../shared/bot-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ConnectorRefResolver } from '../../../connector-cloud/connector-ref-resolution'
import { botAutomationCreateRules, patchBotAutomationUpdate } from './runtime-automation-bot-update'
import type { BotChatLookup } from './runtime-automation-target'

// The thread the bot's turn answered, as its chat's link names it: no place known yet.
const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C08NLB8LXCP:1795700000.000100',
  sessionId: 'thread-chat'
} as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; routing reads only id, agent and folder
const bot = { id: 'b1', name: 'Ranger', agent: 'claude', folderWorkspaceId: 'w1' } as unknown as Bot

// The cloud resolves a #name, id or link to the channel's ref in its workspace. The partner
// workspace T2 has a channel with the same id as the thread's.
const resolve: ConnectorRefResolver = async (_bot, _source, _role, value) =>
  value.includes('partner.slack.com')
    ? { ref: 'slack:T2:C08NLB8LXCP', label: '#partner-design', key: 'C08NLB8LXCP' }
    : value === '#ui-ux-design' || value === 'C08NLB8LXCP'
      ? { ref: 'slack:T1:C08NLB8LXCP', label: '#ui-ux-design', key: 'C08NLB8LXCP' }
      : { ref: `slack:T1:${value}`, label: '#elsewhere', key: value }

function lookups(
  chat: Awaited<ReturnType<BotChatLookup>>,
  refs: ConnectorRefResolver | null = resolve
): Parameters<typeof botAutomationCreateRules>[0] {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create reads only hearing()
    webhooks: { hearing: (b: Bot) => b } as never,
    triggerPeople: () => null,
    cloudTriggers: () => ({ own: true, github2: true, workflows: true, ciFinished: true }),
    placeRefs: () => refs,
    botChat: async () => chat
  }
}

const IN_THREAD_CHAT = {
  runsIn: 'chat',
  chat: {
    sessionId: 'thread-chat',
    title: 'Onboarding review',
    homeIfGone: true,
    toConversation: true
  },
  resultsTo: 'chat'
} as const

async function created(
  target: Partial<AutomationBotTarget>,
  chat: Awaited<ReturnType<BotChatLookup>> = { title: 'Onboarding review' },
  refs: ConnectorRefResolver | null = resolve
) {
  const input = {
    bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat', originThread: ORIGIN, ...target }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create input carries only the bot target here
  return (await botAutomationCreateRules(lookups(chat, refs), bot, input as never)).bot
}

describe('an automation made answering a thread, once its channel is a ref', () => {
  it('answers in the thread when results name its channel by #name, with no place on the thread', async () => {
    expect(await created({ resultsTo: { channel: '#ui-ux-design' } })).toEqual({
      botId: 'b1',
      originThread: ORIGIN,
      ...IN_THREAD_CHAT
    })
  })

  it('posts top-level for the same channel id in another workspace, named by its link', async () => {
    const link = 'https://partner.slack.com/archives/C08NLB8LXCP'
    const saved = await created({ resultsTo: { channel: link } })
    expect(saved).toMatchObject({ runsIn: 'new', resultsTo: { ref: 'slack:T2:C08NLB8LXCP' } })
  })

  it('answers in the thread for its channel by bare id where the cloud takes no refs', async () => {
    expect(await created({ resultsTo: { channel: 'C08NLB8LXCP' } }, undefined, null)).toEqual({
      botId: 'b1',
      originThread: ORIGIN,
      ...IN_THREAD_CHAT
    })
  })

  it('still answers in the thread when the chat Orca chose closed before the save', async () => {
    const chosen = {
      chat: { sessionId: 'thread-chat', homeIfGone: true, toConversation: true }
    } as const
    const saved = await created({ runsIn: 'chat', ...chosen }, null)
    expect(saved).toEqual({ botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN })
  })

  it('still refuses a missing chat the caller named by id', async () => {
    await expect(
      created({ runsIn: 'chat', chat: { sessionId: 'other-chat' }, resultsTo: 'chat' }, null)
    ).rejects.toThrow('has no chat chat:other-chat')
  })

  it('posts into the thread from a new conversation once the chat that made it is gone', async () => {
    const saved = await created({ resultsTo: 'thread' }, null)
    expect(saved).toEqual({ botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN })
  })

  it('keeps an event-started automation on its events, remembering the thread', async () => {
    const input = {
      bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN },
      on: [{ id: 'e1', source: 'slack', event: 'message' }]
    } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create input carries only the bot target and rules here
    const saved = await botAutomationCreateRules(lookups({ title: null }), bot, input as never)
    expect(saved.bot).toEqual(input.bot)
  })
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only settings and bots here
const store = {
  getSettings: () => ({ botsEnabled: true }),
  getBots: () => [bot]
} as never as RuntimeStore

async function edited(
  saved: Partial<Automation> & { bot: AutomationBotTarget },
  patch: { bot?: AutomationBotTarget; on?: Automation['on'] },
  chat: Awaited<ReturnType<BotChatLookup>> = { title: 'Onboarding review' }
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an edit reads only the saved target and rules
  const current = { id: 'a1', ...saved } as Automation & { bot: AutomationBotTarget }
  const next = { ...patch }
  await patchBotAutomationUpdate(lookups(chat), store, current, { ...patch }, next)
  return next.bot
}

describe('editing where it answers', () => {
  it('routes results to its own channel back under the thread', async () => {
    // What a client sends back: no originThread (the schema strips it) and the new place.
    const bot2 = await edited(
      { bot: { botId: 'b1', ...IN_THREAD_CHAT, originThread: ORIGIN } },
      { bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C08NLB8LXCP' } } }
    )
    expect(bot2).toEqual({ botId: 'b1', originThread: ORIGIN, ...IN_THREAD_CHAT })
  })

  it('reroutes when an edit drops its events, though it sent no target', async () => {
    const bot2 = await edited(
      {
        on: [{ id: 'e1', source: 'slack', event: 'message' }],
        bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN }
      },
      { on: [] }
    )
    expect(bot2).toEqual({ botId: 'b1', originThread: ORIGIN, ...IN_THREAD_CHAT })
  })

  it.each([
    ['with the chat it continues', { ...IN_THREAD_CHAT }, IN_THREAD_CHAT],
    ['with no chat', { runsIn: 'new', resultsTo: 'thread' }, { runsIn: 'new', resultsTo: 'thread' }]
  ] as const)(
    'keeps a target saved before the thread kept its chat, %s',
    async (_l, saved, after) => {
      const { sessionId: _kept, ...older } = ORIGIN
      const bot2 = await edited(
        { bot: { botId: 'b1', ...saved, originThread: older } },
        // A rename-free edit that sends the target back as the client read it.
        { bot: { botId: 'b1', ...saved } }
      )
      expect(bot2).toMatchObject({ botId: 'b1', ...after })
      expect(bot2?.chat?.sessionId ?? null).toBe('chat' in after ? 'thread-chat' : null)
    }
  )
})

describe('saving a thread automation, in the cases C3 found', () => {
  it('refuses a missing chat the caller chose by id, even the thread chat', async () => {
    await expect(
      created({ runsIn: 'chat', chat: { sessionId: 'thread-chat' }, resultsTo: 'chat' }, null)
    ).rejects.toThrow('has no chat chat:thread-chat')
  })

  it("posts top-level for a link the cloud couldn't look up, never as the thread's channel", async () => {
    const failing: ConnectorRefResolver = async () => {
      throw new Error('cloud unavailable')
    }
    const link = 'https://partner.slack.com/archives/C08NLB8LXCP'
    const saved = await created({ resultsTo: { channel: link } }, undefined, failing)
    expect(saved).toMatchObject({ runsIn: 'new', resultsTo: { channel: 'C08NLB8LXCP' } })
  })

  it('keeps the chat of a target saved before the thread kept it when an edit clears the chat', async () => {
    const { sessionId: _kept, ...older } = ORIGIN
    const bot2 = await edited(
      { bot: { botId: 'b1', ...IN_THREAD_CHAT, originThread: older } },
      // An edit to --runs-in new sends no chat.
      { bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' } }
    )
    expect(bot2).toEqual({ botId: 'b1', originThread: ORIGIN, ...IN_THREAD_CHAT })
  })
})
