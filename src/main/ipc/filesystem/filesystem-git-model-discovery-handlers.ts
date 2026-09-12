import { ipcMain } from 'electron'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { CommitMessageAgentRuntimeTarget } from '../../text-generation/commit-message-agent-environment'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  type DiscoverCommitMessageModelsResult
} from '../../text-generation/commit-message-text-generation'
import { normalizeSourceControlAiSettings } from '../../../shared/source-control-ai'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import { parseWslPath } from '../../wsl'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import {
  resolveModelDiscoveryLocalPath,
  getLocalAgentRuntimeTarget
} from './filesystem-source-control-ai-targets'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemGitModelDiscoveryHandlers(
  context: FilesystemHandlerContext
): void {
  const { store, commitMessageAgentEnv } = context
  ipcMain.handle(
    'git:discoverCommitMessageModels',
    async (
      _event,
      args: { agentId: string; worktreePath?: string; connectionId?: string }
    ): Promise<DiscoverCommitMessageModelsResult> => {
      const agentId = args.agentId
      const agentCommandOverride = store.getSettings().agentCmdOverrides?.[agentId as TuiAgent]
      // Resolve the user-configured timeout for model discovery, matching the
      // value used by the generation flow.
      const normalizedSettings = normalizeSourceControlAiSettings(
        store.getSettings().sourceControlAi,
        store.getSettings().commitMessageAi
      )
      const generationTimeoutMs = normalizedSettings.generationTimeoutMs
      if (args.connectionId) {
        if (!args.worktreePath) {
          return { success: false, error: 'Missing worktree path for remote model discovery.' }
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return {
            success: false,
            error: `No git provider for connection "${args.connectionId}"`
          }
        }
        return discoverCommitMessageModelsRemote(
          agentId as TuiAgent,
          args.worktreePath,
          (plan, cwd, timeoutMs) => provider.executeCommitMessagePlan(plan, cwd, timeoutMs),
          agentCommandOverride,
          generationTimeoutMs
        )
      }
      let localRuntimeTarget: CommitMessageAgentRuntimeTarget = { runtime: 'host' }
      let localDiscoveryOptions: Parameters<typeof discoverCommitMessageModelsLocal>[3]
      if (args.worktreePath) {
        const worktreePath = await resolveModelDiscoveryLocalPath(store, args.worktreePath)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        const wslDistro = gitOptions.wslDistro ?? parseWslPath(args.worktreePath)?.distro
        localRuntimeTarget = wslDistro
          ? { runtime: 'wsl', wslDistro }
          : getLocalAgentRuntimeTarget(gitOptions)
        localDiscoveryOptions = wslDistro ? { cwd: worktreePath, wslDistro } : { cwd: worktreePath }
      }
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        agentId,
        commitMessageAgentEnv,
        localRuntimeTarget
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return localDiscoveryOptions
        ? discoverCommitMessageModelsLocal(
            agentId as TuiAgent,
            localEnv.env,
            agentCommandOverride,
            localDiscoveryOptions,
            generationTimeoutMs
          )
        : discoverCommitMessageModelsLocal(
            agentId as TuiAgent,
            localEnv.env,
            agentCommandOverride,
            undefined,
            generationTimeoutMs
          )
    }
  )
}
