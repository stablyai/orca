import { ipcMain } from 'electron'
import { getRepoDialableSshTargetId, type ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { hasHooksFile, loadHooks, hasUnrecognizedOrcaYamlKeys } from '../../hooks'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import { blockedWslDistroForPath } from '../../wsl/wsl-unc-access-gate'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

export function registerWorktreeHookCheckHandler(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:check',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId; background?: boolean }) => {
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
      if (isFolderRepo(repo)) {
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

      // A render-driven check must not open a stopped distro's `\\wsl.localhost` paths (E9).
      const blocked = args.background ? await blockedWslDistroForPath(repo.path) : null
      if (blocked) {
        return {
          status: 'error',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false,
          // A stopped distro answers once it runs again; an unverifiable one is worth a retry.
          unavailable:
            blocked.state === 'stopped'
              ? ('wsl-distro-stopped' as const)
              : ('wsl-distro-unverifiable' as const)
        }
      }

      const has = hasHooksFile(repo.path)
      const hooks = has ? loadHooks(repo.path) : null
      // Well-formed unknown keys may come from a newer Orca; suggest updating instead of parse repair.
      const mayNeedUpdate = has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
      return {
        status: 'ok',
        hasHooks: has,
        hooks,
        mayNeedUpdate
      }
    }
  )
}
