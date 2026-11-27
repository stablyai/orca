// A bot's waits: one that ends unrun says so as a card in the chat it would have run in (its Chat
// when that is gone), and is deleted. One whose run started needs no card: its run row says so.
import type { Automation } from '../../shared/automations/automation-definition'
import { botAutomationFacts } from '../../shared/bots/bot-automation-rows'
import type { AutomationOnceEffects } from '../automations/automation-trigger-runs'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { appendOrcaChatCard } from '../runtime/orca-chat-card'
import { runtimeBotChats } from './bot-chat-session'
import { botChatTakingMail } from '../runtime/rpc/methods/bots-chats'

export function runtimeBotWaits(runtime: OrcaRuntimeService): AutomationOnceEffects {
  const chats = runtimeBotChats(runtime)
  // Never fails the expiry it reports.
  const expiredCard = async (automation: Automation): Promise<void> => {
    const target = automation.bot
    const bot = target && runtime.bots.list().find((entry) => entry.id === target.botId)
    if (!target || !bot) {
      return
    }
    try {
      const chosen = target.chat
        ? await botChatTakingMail(runtime, bot, target.chat.sessionId)
        : null
      const sessionId = chosen?.sessionId ?? (await chats.ensure(bot.id))
      appendOrcaChatCard(
        sessionId,
        {
          kind: 'wait-ended',
          automation: botAutomationFacts(automation),
          ending: { kind: 'expired', at: Date.now() }
        },
        'showing how a wait ended'
      )
    } catch (error) {
      console.warn('[bots] could not show how a wait ended', error)
    }
  }
  return {
    expire: async (automation) => {
      await expiredCard(automation)
      await runtime.deleteAutomation(automation.id)
    },
    remove: (automationId) => runtime.deleteAutomation(automationId)
  }
}
