import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import {
  getLocalAgentRuntimeTarget,
  getLocalTextGenerationTarget
} from '../ipc/filesystem/filesystem-source-control-ai-targets'

export async function resolveGenerationTarget(
  worktreePath: string,
  agentId: string,
  deps: { getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined },
  wslDistro?: string
): Promise<CommitMessageGenerationTarget | null> {
  const runtimeOptions = wslDistro ? { wslDistro } : {}
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    agentId,
    deps.getAgentEnvResolvers(),
    getLocalAgentRuntimeTarget(runtimeOptions)
  )
  if (!localEnv.ok) {
    return null
  }
  return getLocalTextGenerationTarget(worktreePath, runtimeOptions, localEnv.env)
}
