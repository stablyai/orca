import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { splitWorktreeId } from '../../../../shared/worktree/id'

/** Maps a paired client's runtime-local host spelling to this host's repo spelling. */
export function resolvePairedCallerHostId(
  getRepos: () => readonly Repo[],
  worktreeSelector: string,
  callerHostId: ExecutionHostId | undefined
): ExecutionHostId | undefined {
  if (!callerHostId || parseExecutionHostId(callerHostId)?.kind !== 'runtime') {
    return callerHostId
  }
  const repoId = splitWorktreeId(
    worktreeSelector.startsWith('id:') ? worktreeSelector.slice(3) : worktreeSelector
  )?.repoId
  const spellings = new Set(
    getRepos()
      .filter((repo) => (repoId ? repo.id === repoId : true))
      .map((repo) => getRepoExecutionHostId(repo))
      .filter((hostId) => hostId === LOCAL_EXECUTION_HOST_ID || hostId === callerHostId)
  )
  if (spellings.size > 1) {
    throw new Error(
      `Workspace identity is ambiguous across hosts: ${worktreeSelector}. Retry with an explicit host.`
    )
  }
  return [...spellings][0] ?? LOCAL_EXECUTION_HOST_ID
}
