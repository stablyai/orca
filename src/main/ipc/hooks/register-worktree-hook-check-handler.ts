import { ipcMain } from 'electron'
import { getRepoDialableSshTargetId, type ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { hasHooksFile, loadHooks, hasUnrecognizedOrcaYamlKeys } from '../../hooks'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

export function registerWorktreeHookCheckHandler(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:check',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo) {
        const repoIdExists = store.getRepos().some((candidate) => candidate.id === args.repoId)
        // Why: callers treat inspection errors as "skip", so a requested/ambiguous host must report error (fail closed), not hook-free.
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
        // Why: this process serves no SSH filesystem.
        return {
          status: 'error',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }

      const has = hasHooksFile(repo.path)
      const hooks = has ? loadHooks(repo.path) : null
      // Why: unrecognised top-level keys mean the file is well-formed but from a newer Orca; suggest updating rather than "could not be parsed".
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
