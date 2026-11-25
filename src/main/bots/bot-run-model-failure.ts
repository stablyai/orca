import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { AutomationRunFailure } from '../../shared/automations/history/automation-run-failure-copy'
import { automationRunModelUnavailable } from '../../shared/automations/history/automation-run-model-failure'
import type { BotRunResult } from './bot-run-results'
import type { BotTurnEnd } from './bot-run-turn-watch'

/** A run continuing a conversation has no launch setup of its own to name. */
export function botRunModelFailure(
  result: Pick<BotRunResult, 'bot' | 'target' | 'launchModel'>,
  ended: Extract<BotTurnEnd, { outcome: unknown }>
): AutomationRunFailure | null {
  const failure = ended.failure ?? readAgentSessionFailureFact(ended.refusal)
  if (failure?.kind !== 'modelUnavailable') {
    return null
  }
  const agent = result.target.runsIn === 'new' ? result.bot.agent : undefined
  const launchModel = agent ? result.launchModel : undefined
  const model = failure.detail?.text ?? launchModel
  return automationRunModelUnavailable({
    ...(agent ? { agent, agentLabel: tuiAgentDisplayName(agent) ?? agent } : {}),
    model,
    launchModel
  })
}
