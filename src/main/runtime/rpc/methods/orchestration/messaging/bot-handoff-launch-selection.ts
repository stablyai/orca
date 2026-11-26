import { checkAgentLaunchModelPreferences } from '../../../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import {
  agentSessionExecutionOptionsRecord,
  readAgentSessionExecutionOptions
} from '../../../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { BotAgent } from '../../../../../../shared/bot-types'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export function resolveBotHandoffLaunchOptions(
  agent: BotAgent,
  { model, effort }: { model?: string; effort?: string }
): Readonly<Record<string, string>> | undefined {
  if (model === undefined) {
    return undefined
  }
  // Other chat adapters can defer or skip choices based on the provider's live options.
  if (agent !== 'codex') {
    throw new OrchestrationError(
      'capability_unsupported',
      `Bot handoff model and effort overrides are supported for Codex chats. The receiving bot uses ${agent}.`
    )
  }
  const checked = checkAgentLaunchModelPreferences({ agent, model, effort })
  if ('refusal' in checked) {
    throw new OrchestrationError(checked.refusal.code, checked.refusal.message)
  }
  const execution = readAgentSessionExecutionOptions(checked.preferences)
  if (!execution || model.includes('\0')) {
    throw new OrchestrationError('invalid_argument', 'Invalid model or effort for a bot chat.')
  }
  return agentSessionExecutionOptionsRecord(execution)
}
