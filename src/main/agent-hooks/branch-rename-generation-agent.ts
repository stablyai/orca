import type { TuiAgent } from '../../shared/types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'

/** Workspace agent when it has a non-interactive SC AI generation contract. */
export function asSupportedBranchRenameAgent(
  workspaceAgent: string | null | undefined
): TuiAgent | undefined {
  if (!workspaceAgent || !isTuiAgent(workspaceAgent)) {
    return undefined
  }
  return getCommitMessageAgentSpec(workspaceAgent) ? workspaceAgent : undefined
}

/**
 * Prefer the workspace/selected agent for first-work branch rename when it
 * supports Source Control AI text generation; otherwise keep the configured SC AI agent.
 */
export function pickBranchRenameGenerationAgent(
  configuredAgentId: TuiAgent | 'custom',
  workspaceAgent: string | null | undefined
): TuiAgent | 'custom' {
  return asSupportedBranchRenameAgent(workspaceAgent) ?? configuredAgentId
}
