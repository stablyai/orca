import { ipcMain } from 'electron'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { CommitMessageAgentRuntimeTarget } from '../../text-generation/commit-message-agent-environment'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../../text-generation/commit-message-text-generation'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import { agentLaunchWslDistro } from '../../runtime/terminal/launch/agent-launch-scope-runtime'
import { runtimePathsEqual } from '../../runtime/workspaces/catalog/runtime-worktree-path-identity'
import { resolveModelDiscoveryLocalPath } from './filesystem-source-control-ai-targets'
import { getLocalRepoForRegisteredWorktree } from '../local-worktree-runtime-options'
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
      if (args.connectionId) {
        if (!args.worktreePath) {
          return { success: false, error: 'Missing worktree path for remote model discovery.' }
        }
        return {
          success: false,
          error: `No git provider for connection "${args.connectionId}"`
        }
      }
      let localRuntimeTarget: CommitMessageAgentRuntimeTarget = { runtime: 'host' }
      let localDiscoveryOptions: Parameters<typeof discoverCommitMessageModelsLocal>[3]
      if (args.worktreePath) {
        const worktreePath = await resolveModelDiscoveryLocalPath(store, args.worktreePath)
        const folder = store
          .getFolderWorkspaces?.()
          .find((row) => runtimePathsEqual(row.folderPath, args.worktreePath!))
        const repo = folder
          ? null
          : (getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath) ?? null)
        const scope = {
          id: folder ? `folder:${folder.id}` : (repo?.id ?? ''),
          path: worktreePath,
          connectionId: null,
          repo,
          folderWorkspace: folder ?? null
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing discovery boundary admits agent IDs before launch planning.
        const wslDistro = agentLaunchWslDistro(store, scope, agentId as TuiAgent)
        localRuntimeTarget = wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
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
            localDiscoveryOptions
          )
        : discoverCommitMessageModelsLocal(agentId as TuiAgent, localEnv.env, agentCommandOverride)
    }
  )
}
