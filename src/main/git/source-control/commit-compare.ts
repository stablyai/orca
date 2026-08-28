import type { GitCommitCompareResult } from '../../../shared/git-diff-compare-types'
import { parseGitRevListFirstParentOid } from '../../../shared/git-rev-list-output'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { loadCommitChanges } from './branch-change-entries'
import { resolveRefOid } from './compare-ref-oids'

export async function getCommitCompare(
  worktreePath: string,
  commitId: string,
  options: GitRuntimeOptions = {}
): Promise<GitCommitCompareResult> {
  let commitOid = ''
  try {
    commitOid = await resolveRefOid(worktreePath, `${commitId}^{commit}`, options)
  } catch {
    return {
      summary: {
        commitOid: '',
        parentOid: null,
        compareRef: commitId,
        baseRef: 'parent',
        changedFiles: 0,
        status: 'invalid-commit',
        errorMessage: `Commit ${commitId} could not be resolved in this repository.`
      },
      entries: []
    }
  }

  const summary = {
    commitOid,
    parentOid: null as string | null,
    compareRef: commitOid.slice(0, 7),
    baseRef: 'empty tree',
    changedFiles: 0,
    status: 'ready' as const
  }

  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--parents', '-n', '1', commitOid],
      gitOptionsForWorktree(worktreePath, options)
    )
    const firstParent = parseGitRevListFirstParentOid(stdout)
    summary.parentOid = firstParent
    summary.baseRef = firstParent ? firstParent.slice(0, 7) : 'empty tree'

    const entries = await loadCommitChanges(worktreePath, summary.parentOid, commitOid, options)
    summary.changedFiles = entries.length
    return { summary, entries }
  } catch (error) {
    return {
      summary: {
        ...summary,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to load commit diff'
      },
      entries: []
    }
  }
}
