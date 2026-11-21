import { vi } from 'vitest'
import type {
  AutomationBotTarget,
  AutomationCreateInput
} from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { Store } from '../persistence/loading-store/store'
import { makeTestBot } from '../bots/bot.test-fixture'
import type { BotAutomationSessions, BotRunResults } from './bot-automation-launch'
import type { BotTurnEnd } from '../bots/bot-run-turn-watch'

// These tests write times on the host's clock, so the automation lives in the host's zone.
const HOST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export function seedBot(store: Store, overrides: Partial<Bot> = {}): Bot {
  const group = store.createProjectGroup({
    name: 'Reviewer',
    createdFrom: 'manual',
    parentPath: '/bots/reviewer'
  })
  const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Reviewer' })
  const bot = makeTestBot({ folderWorkspaceId: workspace.id, ...overrides })
  store.saveBot(bot)
  return bot
}

export function seedBotAutomation(
  store: Store,
  bot: Bot,
  target: Partial<AutomationBotTarget> = {},
  input: Partial<AutomationCreateInput> = {}
) {
  return store.createAutomation({
    name: 'Morning digest',
    prompt: 'Summarize what changed overnight',
    agentId: bot.agent,
    bot: { botId: bot.id, runsIn: 'new', resultsTo: 'chat', ...target },
    projectId: '',
    workspaceMode: 'existing',
    workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
    timezone: HOST_TIMEZONE,
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime(),
    ...input
  })
}

export function fakeSessions() {
  return {
    startConversation: vi.fn<BotAutomationSessions['startConversation']>(async () => ({
      sessionId: 'new-session',
      clientMessageId: 'new-message',
      fingerprint: 'new-fingerprint'
    })),
    sendToBotChat: vi.fn<BotAutomationSessions['sendToBotChat']>(async (_bot, chatId) => ({
      sessionId: chatId,
      clientMessageId: 'chat-message',
      fingerprint: 'chat-fingerprint'
    })),
    sendToSession: vi.fn<BotAutomationSessions['sendToSession']>(async (_bot, sessionId) => ({
      sessionId,
      clientMessageId: 'owner-message',
      fingerprint: 'owner-fingerprint'
    })),
    sendToChat: vi.fn<BotAutomationSessions['sendToChat']>(async () => ({
      sessionId: 'chat-session',
      clientMessageId: 'chat-message',
      fingerprint: 'chat-fingerprint'
    })),
    release: vi.fn<BotAutomationSessions['release']>(async () => undefined)
  }
}

/** A run whose turn never ends, unless the test ends it. */
export function fakeResults() {
  let endTurn: (ended: BotTurnEnd) => void = () => {}
  const dispose = vi.fn<() => void>()
  const results = {
    watch: vi.fn<BotRunResults['watch']>(async () => ({
      next: () => new Promise<BotTurnEnd>((resolve) => (endTurn = resolve)),
      dispose
    })),
    couldNotStart: vi.fn<BotRunResults['couldNotStart']>(),
    deliver: vi.fn<BotRunResults['deliver']>(async ({ ended }) => ({
      status: 'completed',
      outputSnapshot:
        'message' in ended
          ? { format: 'plain_text', content: ended.message, capturedAt: 1, truncated: false }
          : null
    }))
  }
  return { results, dispose, endTurn: (ended: BotTurnEnd) => endTurn(ended) }
}
