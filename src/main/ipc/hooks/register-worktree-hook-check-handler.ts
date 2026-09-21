import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from '../../runtime/runtime-relative-paths'
import { parseOrcaYaml, hasHooksFile, loadHooks, hasUnrecognizedOrcaYamlKeys } from '../../hooks'
import { isENOENT } from '../filesystem-path-containment'
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

      if (repo.connectionId) {
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          return { status: 'error', hasHooks: false, hooks: null, mayNeedUpdate: false }
        }
        try {
          const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
          return {
            status: 'ok',
            hasHooks: !result.isBinary,
            hooks: result.isBinary ? null : parseOrcaYaml(result.content),
            mayNeedUpdate: false
          }
        } catch (error) {
          return {
            status: isENOENT(error) ? 'ok' : 'error',
            hasHooks: false,
            hooks: null,
            mayNeedUpdate: false
          }
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
