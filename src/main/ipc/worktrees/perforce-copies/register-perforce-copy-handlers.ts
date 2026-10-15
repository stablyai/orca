import { ipcMain } from 'electron'
import { isPerforceCopyOperationName } from '../../../../shared/perforce/workspace-copy/workspace-copy-operations'
import type { WorkspaceCopyIpcResult } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

// Why the host: a project id can be registered on this computer and on an SSH host at once.
function requireProjectOnHost(repos: readonly Repo[], repoId: string, hostId?: string): Repo {
  const matches = repos.filter((repo) => repo.id === repoId)
  const repo = hostId
    ? matches.find((candidate) => getRepoExecutionHostId(candidate) === hostId)
    : matches[0]
  if (!repo) {
    throw new Error(
      'This project is no longer in Orca on this host. Refresh projects and try again.'
    )
  }
  return repo
}

/** Copy operations of this desktop's folder projects, done by its runtime as for a paired client. */
export function registerPerforceCopyHandlers(context: WorktreeIpcContext): void {
  ipcMain.handle(
    'perforce:runCopy',
    async (
      _event,
      operation: unknown,
      args: Record<string, unknown> & { repoId: string; hostId?: string }
    ): Promise<WorkspaceCopyIpcResult<unknown>> => {
      try {
        if (!isPerforceCopyOperationName(operation)) {
          throw new Error('Unknown Perforce copy operation')
        }
        // Why no settings: without a client's, the runtime applies this desktop's Settings > Perforce.
        const { repoId, hostId, ...params } = args
        const value = await context.runtime.runPerforceCopyOperationOnRepo(
          requireProjectOnHost(context.store.getRepos(), repoId, hostId),
          operation,
          params
        )
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
