import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { isLaunchConfigClaudeAccountId } from '../../../../shared/claude/project-claude-account-preference'

/**
 * Account fields a background terminal create forwards to the PTY spawn: an explicit `--account`,
 * else the launch config's recorded choice, which the spawn resolves below any explicit pin.
 */
export function terminalCreateClaudeAccountIdField(launchOpts: {
  claudeAccountId?: string
  launchClaudeAccountId?: string
  launchConfig?: Pick<SleepingAgentLaunchConfig, 'claudeAccountId'>
}): { claudeAccountId?: string; launchConfigClaudeAccountId?: string } {
  if (launchOpts.claudeAccountId) {
    return { claudeAccountId: launchOpts.claudeAccountId }
  }
  const recorded = launchOpts.launchConfig?.claudeAccountId ?? launchOpts.launchClaudeAccountId
  return isLaunchConfigClaudeAccountId(recorded) ? { launchConfigClaudeAccountId: recorded } : {}
}
