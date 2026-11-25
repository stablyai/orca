import { ipcMain } from 'electron'
import {
  getRepoDialableSshTargetId,
  isRepoOnCatalogHost,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import { inspectWorkspaceHooks } from '../../workspace-hooks/workspace-hook-inspection'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'
import type { SetupHooksCreateSource } from '../../../shared/worktree/setup-hooks-create-source'
import { readCreateSourceSetupHooks } from '../../workspace-hooks/create-source-setup-hooks'
import { getWorktreeCreatePrefetchGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'

export function registerWorktreeHookCheckHandler(context: WorktreeIpcContext): void {
  const { store, runtime } = context

  ipcMain.handle(
    'hooks:check',
    async (
      _event,
      args: {
        repoId: string
        hostId?: ExecutionHostId
        background?: boolean
        createSource?: SetupHooksCreateSource
      }
    ) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo) {
        const repoIdExists = store.getRepos().some((candidate) => candidate.id === args.repoId)
        // Ambiguous/requested hosts must report error, not hook-free success, so callers cannot skip inspection.
        return {
          status: args.hostId || repoIdExists ? 'error' : 'ok',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }
      // A folder owned by another host has no hooks here; its own host reports them.
      if (isFolderRepo(repo) && !isRepoOnCatalogHost(repo)) {
        return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
      }

      if (getRepoDialableSshTargetId(repo)) {
        return {
          status: 'error',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }

      if (args.createSource && !args.background) {
        const created = await readCreateSourceSetupHooks({
          repo,
          source: args.createSource,
          runtime,
          gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo)
        })
        if (created) {
          return {
            status: 'ok',
            hasHooks: created.hooks !== null,
            hooks: created.hooks,
            mayNeedUpdate: false
          }
        }
      }

      return inspectWorkspaceHooks(repo, args.background)
    }
  )
}
