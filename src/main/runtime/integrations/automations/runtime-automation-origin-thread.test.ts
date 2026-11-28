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

// The thread the bot's turn answered, as its chat's link names it.
const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C08NLB8LXCP:1795700000.000100',
  place: '#ui-ux-design',
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
      : { ref: `slack:T1:${value}`, label: '#news', key: value }

function lookups(
  refs: ConnectorRefResolver | null = resolve
): Parameters<typeof botAutomationCreateRules>[0] {
  const chat: BotChatLookup = async (_bot, id) =>
    id === 'thread-chat' ? { title: 'Onboarding review' } : id === 'other' ? { title: null } : null
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create reads only hearing()
    webhooks: { hearing: (b: Bot) => b } as never,
    triggerPeople: () => null,
    cloudTriggers: () => ({ own: true, github2: true, workflows: true, ciFinished: true }),
    placeRefs: () => refs,
    botChat: chat
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
  options: { refs?: ConnectorRefResolver | null; on?: Automation['on'] } = {}
) {
  const input = {
    bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat', originThread: ORIGIN, ...target },
    ...(options.on ? { on: options.on } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create input carries only the bot target and rules here
  return (await botAutomationCreateRules(lookups(options.refs), bot, input as never)).bot
}

describe('an automation made answering a thread, once its places are refs', () => {
  it('runs in the thread chat for --runs-in new --results-to channel:<the thread channel>', async () => {
    // The incident: a redo asked for in a thread was posted top-level in the same channel.
    expect(await created({ resultsTo: { channel: 'C08NLB8LXCP' } })).toEqual({
      botId: 'b1',
      originThread: ORIGIN,
      ...IN_THREAD_CHAT
    })
  })

  it.each([['thread'], ['chat']] as const)(
    'runs in the thread chat for --results-to %s',
    async (resultsTo) => {
      expect(await created({ resultsTo })).toEqual({
        botId: 'b1',
        originThread: ORIGIN,
        ...IN_THREAD_CHAT
      })
    }
  )

  it('keeps a channel with the same id in another workspace as a top-level post', async () => {
    const link = 'https://partner.slack.com/archives/C08NLB8LXCP'
    expect(await created({ resultsTo: { channel: link } })).toMatchObject({
      runsIn: 'new',
      resultsTo: { ref: 'slack:T2:C08NLB8LXCP' }
    })
  })

  it('counts a channel Orca could not look up as elsewhere', async () => {
    expect(await created({ resultsTo: { channel: 'C08NLB8LXCP' } }, { refs: null })).toMatchObject({
      runsIn: 'new',
      resultsTo: { channel: 'C08NLB8LXCP' }
    })
  })

  it.each([
    ['none', 'none'],
    ['a Linear issue', { linearIssue: 'ENG-1' }],
    ['another channel', { channel: '#news' }]
  ] as const)('keeps results sent to %s', async (_label, resultsTo) => {
    expect(await created({ resultsTo })).toMatchObject({ runsIn: 'new', originThread: ORIGIN })
  })

  it("keeps results in Orca, never top-level in the thread's channel, on its own agent", async () => {
    const agentSetup = { agent: 'codex' } as const
    expect(await created({ agentSetup, resultsTo: { channel: 'C08NLB8LXCP' } })).toMatchObject({
      runsIn: 'new',
      agentSetup,
      resultsTo: 'chat'
    })
  })

  it('leaves an automation that events start on its events', async () => {
    const on = [{ id: 'e1', source: 'slack', event: 'message' }] as const
    expect(await created({ resultsTo: 'thread' }, { on: [...on] })).toEqual({
      botId: 'b1',
      runsIn: 'new',
      resultsTo: 'thread',
      originThread: ORIGIN
    })
  })
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only settings and bots here
const store = {
  getSettings: () => ({ botsEnabled: true }),
  getBots: () => [bot]
} as never as RuntimeStore

describe('editing where it answers', () => {
  it("routes results to the thread's own channel back under the thread", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an edit reads only the saved target
    const current = {
      id: 'a1',
      bot: { botId: 'b1', ...IN_THREAD_CHAT, originThread: ORIGIN }
    } as Automation & {
      bot: AutomationBotTarget
    }
    // What a client sends back: no originThread (the schema strips it) and the new place.
    const patch: { bot?: AutomationBotTarget } = {
      bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C08NLB8LXCP' } }
    }
    await patchBotAutomationUpdate(lookups(), store, current, { ...patch }, patch)
    expect(patch.bot).toEqual({ botId: 'b1', originThread: ORIGIN, ...IN_THREAD_CHAT })
  })
})
