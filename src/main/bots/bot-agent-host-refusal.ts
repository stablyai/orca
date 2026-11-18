// This host's answer to `botAgentHostRefusal`, from the same managed-runtime pin its agent list publishes.
import { botAgentHostRefusal } from '../../shared/bots/bot-agent-runtime'
import { hostHasManagedRuntime } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'

/** Refuses a bot on `agent` (absent keeps its current one) where this host could not run it. */
export function assertBotAgentRunsOnThisHost(agent: string | undefined): void {
  const refusal = agent ? botAgentHostRefusal(agent, hostHasManagedRuntime(agent)) : null
  if (refusal) {
    throw new Error(refusal)
  }
}
