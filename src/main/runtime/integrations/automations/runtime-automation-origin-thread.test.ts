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

// The cloud resolves a #name to the channel's ref in its workspace.
const resolve: ConnectorRefResolver = async (_bot, _source, _role, value) =>
  value === '#ui-ux-design' || value === 'C08NLB8LXCP'
    ? { ref: 'slack:T1:C08NLB8LXCP', label: '#ui-ux-design', key: 'C08NLB8LXCP' }
    : { ref: `slack:T2:${value}`, label: '#elsewhere', key: value }

function lookups(
  chat: Awaited<ReturnType<BotChatLookup>>
): Parameters<typeof botAutomationCreateRules>[0] {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create reads only hearing()
    webhooks: { hearing: (b: Bot) => b } as never,
    triggerPeople: () => null,
    cloudTriggers: () => ({ own: true, github2: true, workflows: true, ciFinished: true }),
    placeRefs: () => resolve,
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
}

async function created(
  target: Partial<AutomationBotTarget>,
  chat: Awaited<ReturnType<BotChatLookup>> = { title: 'Onboarding review' }
) {
  const input = {
    bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat', originThread: ORIGIN, ...target }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create input carries only the bot target here
  return (await botAutomationCreateRules(lookups(chat), bot, input as never)).bot
}

describe('an automation made answering a thread, once its channel is a ref', () => {
  it('answers in the thread when results name its channel by #name, with no place on the thread', async () => {
    expect(await created({ resultsTo: { channel: '#ui-ux-design' } })).toEqual({
      botId: 'b1',
      originThread: ORIGIN,
      ...IN_THREAD_CHAT
    })
  })

  it('posts top-level for the same channel id in another workspace', async () => {
    const saved = await created({ resultsTo: { channel: 'C0OTHER' } })
    expect(saved).toMatchObject({ runsIn: 'new', resultsTo: { ref: 'slack:T2:C0OTHER' } })
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

describe('editing where it answers', () => {
  it('routes results to its own channel back under the thread', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only settings and bots here
    const store = {
      getSettings: () => ({ botsEnabled: true }),
      getBots: () => [bot]
    } as never as RuntimeStore
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an edit reads only the saved bot target
    const current = {
      id: 'a1',
      bot: { botId: 'b1', ...IN_THREAD_CHAT, originThread: ORIGIN }
    } as Automation & { bot: AutomationBotTarget }
    // What a client sends back: no originThread (the schema strips it) and the new place.
    const patch = {
      bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C08NLB8LXCP' } }
    } as const
    const edited: { bot?: AutomationBotTarget } = { ...patch }
    await patchBotAutomationUpdate(
      lookups({ title: 'Onboarding review' }),
      store,
      current,
      {},
      edited
    )
    expect(edited.bot).toEqual({ botId: 'b1', originThread: ORIGIN, ...IN_THREAD_CHAT })
  })
})
