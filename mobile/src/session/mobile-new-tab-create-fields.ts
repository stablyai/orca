import { isCustomTuiAgentId } from '../../../src/shared/custom-tui-agent-identity'
import type { TuiAgent } from '../../../src/shared/tui-agent'

export function buildMobileNewTabCreateFields(args: {
  agent?: TuiAgent
  agentPrompt?: string
  startupCommand?: string
  startupCommandDelivery?: 'shell-ready'
}): Record<string, unknown> {
  if (args.agent && isCustomTuiAgentId(args.agent)) {
    return {
      agentLaunch: {
        selection: { kind: 'agent', agent: args.agent },
        ...(args.agentPrompt ? { prompt: args.agentPrompt } : { allowEmptyPromptLaunch: true })
      }
    }
  }
  return {
    ...(args.startupCommand ? { command: args.startupCommand } : {}),
    ...(args.startupCommandDelivery ? { startupCommandDelivery: args.startupCommandDelivery } : {}),
    ...(args.agentPrompt ? { agentPrompt: args.agentPrompt } : {}),
    ...(args.agent ? { agent: args.agent } : {})
  }
}
