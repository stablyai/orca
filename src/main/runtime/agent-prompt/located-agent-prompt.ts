import type { PendingAgentPrompt } from '../../../shared/rpc-contract/agent-prompt-params'

export type LocatedAgentPrompt = {
  prompt: PendingAgentPrompt
  paneKey: string
  agent: string
}
