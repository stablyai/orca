import { workspaceKindForLaunchTarget } from '../../shared/agent-launch/contracts/workspace-launch-kind'
import type { AgentLaunchIntent } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { withAgentWorktreePolicy } from '../../shared/agent-launch/policy/agent-worktree-policy'

export function withAgentLaunchWorktreePolicy<T extends { intent: AgentLaunchIntent }>(
  execution: T
): T {
  const { intent } = execution
  const workspaceKind = workspaceKindForLaunchTarget(intent.target)
  // A reused terminal is an ongoing conversation; promptless pane launches have client-owned text.
  if (!intent.prompt || intent.reuseTerminal || workspaceKind === 'floating') {
    return execution
  }
  const create = intent.target.kind === 'create-worktree' ? intent.target.create : undefined
  const baseline = create?.compareBaseRef ?? create?.baseBranch
  return {
    ...execution,
    intent: {
      ...intent,
      prompt: {
        ...intent.prompt,
        text: withAgentWorktreePolicy(intent.prompt.text, {
          baseline: typeof baseline === 'string' ? baseline : undefined,
          workspaceKind
        })
      }
    }
  }
}
