import type { CommitMessageGenerationTarget } from '../../text-generation/source-control-text-generation-types'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../../text-generation/execution/commit-message-agent-environment'

export async function resolveGenerationTarget(
  worktreePath: string,
  agentId: string,
  deps: { getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined }
): Promise<CommitMessageGenerationTarget | null> {
  const localEnv = await prepareLocalCommitMessageAgentEnv(agentId, deps.getAgentEnvResolvers())
  if (!localEnv.ok) {
    return null
  }
  return { kind: 'local', cwd: worktreePath, ...(localEnv.env ? { env: localEnv.env } : {}) }
}
