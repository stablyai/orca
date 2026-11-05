import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeCommitMessageSettingsOverride } from './runtime-git-generation-context'
import { localAgentRuntimeTargetForTarget } from './runtime-git-generation-context'
import {
  localGitOptionsForTarget,
  runtimeGitRouteForTarget,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../text-generation/commit-message-text-generation'

export async function discoverRuntimeCommitMessageModels(
  host: RuntimeGitCommandHost,
  worktreeSelector: string,
  agentId: string,
  settingsOverride?: Pick<RuntimeCommitMessageSettingsOverride, 'agentCmdOverrides'>
): Promise<DiscoverCommitMessageModelsResult> {
  const target = await host.resolveRuntimeGitTarget(worktreeSelector)
  const typedAgentId = agentId as TuiAgent
  const agentCommandOverride =
    settingsOverride?.agentCmdOverrides?.[typedAgentId] ??
    host.getRuntimeSettings().agentCmdOverrides?.[typedAgentId]
  const route = runtimeGitRouteForTarget(target)
  if (route.kind === 'ssh') {
    return {
      success: false,
      error: `No git provider for connection "${route.connectionId}"`
    }
  }
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    typedAgentId,
    host.getCommitMessageAgentEnvironment?.(),
    localAgentRuntimeTargetForTarget(target)
  )
  if (!localEnv.ok) {
    return { success: false, error: localEnv.error }
  }
  const localOptions = localGitOptionsForTarget(target)
  return localOptions.wslDistro
    ? discoverCommitMessageModelsLocal(typedAgentId, localEnv.env, agentCommandOverride, {
        cwd: target.worktree.path,
        wslDistro: localOptions.wslDistro
      })
    : discoverCommitMessageModelsLocal(typedAgentId, localEnv.env, agentCommandOverride)
}
