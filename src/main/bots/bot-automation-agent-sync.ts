// A bot automation's agentId is the agent its runs start on, so every reader can show and filter by
// it; a bot switching agents moves the automations that follow it.
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import { BotAgentSetupSchema, botAutomationSetup } from '../../shared/bots/bot-agent-setup'

type BotAutomationAgent = Pick<Automation, 'id' | 'agentId' | 'bot'>

function runAgent(automation: BotAutomationAgent, bots: readonly Bot[]): Bot['agent'] | null {
  // A row a damaged store left empty has no bot to follow.
  const target = automation?.bot
  const bot = target && bots.find((entry) => entry.id === target.botId)
  return target && bot ? botAutomationSetup(target, bot).agent : null
}

/** A stored setup this Orca can't run (an agent since held back) is dropped, so the automation
 *  runs on its bot's agent and its next edit doesn't fail on it. */
function withoutUnreadableSetup<A extends BotAutomationAgent>(automation: A): A {
  const target = automation?.bot
  if (!target?.agentSetup || BotAgentSetupSchema.safeParse(target.agentSetup).success) {
    return automation
  }
  console.warn(
    `[bots] automation ${automation.id} named an agent setup this Orca can't run; it runs on its bot's agent now`
  )
  const { agentSetup: _dropped, ...bot } = target
  return { ...automation, bot }
}

/** As the store loads: unreadable setups go, and automations whose bots switched agents before
 *  they followed catch up. */
export function withBotAutomationAgents<A extends BotAutomationAgent>(
  automations: A[],
  bots: readonly Bot[],
  changed: () => void
): A[] {
  let moved = false
  const next = automations.map((stored) => {
    const automation = withoutUnreadableSetup(stored)
    const agent = runAgent(automation, bots)
    if (automation === stored && (agent === null || agent === automation.agentId)) {
      return stored
    }
    moved = true
    return agent === null ? automation : { ...automation, agentId: agent }
  })
  if (!moved) {
    return automations
  }
  changed()
  return next
}

/** After the bot's agent changed: each of its automations that follows it records the new agent. */
export async function syncBotAutomationAgents(
  automations: readonly BotAutomationAgent[],
  bot: Bot,
  update: (automationId: string, agentId: Bot['agent']) => Promise<unknown>
): Promise<void> {
  for (const automation of automations) {
    if (automation.bot?.botId !== bot.id) {
      continue
    }
    const agent = runAgent(automation, [bot])
    if (agent !== null && agent !== automation.agentId) {
      await update(automation.id, agent)
    }
  }
}
