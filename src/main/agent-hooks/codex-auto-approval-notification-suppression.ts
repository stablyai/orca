import type { AgentStatusState } from '../../shared/agent-status-types'
import { isAskUserQuestionTool } from '../../shared/agent-question-answered-intent'
import { resolveTuiAgentPermissionMode } from '../../shared/tui-agent-permissions'

export function shouldSuppressCodexAutoApprovalSyntheticTitleFromHook(args: {
  agentType: string | null | undefined
  state: AgentStatusState
  toolName?: string | null
  launchConfig:
    | {
        agentArgs?: string | null
        agentEnv?: Record<string, string> | null
      }
    | null
    | undefined
}): boolean {
  if (args.agentType !== 'codex' || (args.state !== 'waiting' && args.state !== 'blocked')) {
    return false
  }
  if (isAskUserQuestionTool(args.toolName ?? undefined)) {
    return false
  }
  if (!args.launchConfig) {
    return false
  }
  return (
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: args.launchConfig.agentArgs,
      agentEnv: args.launchConfig.agentEnv
    }) === 'yolo'
  )
}
