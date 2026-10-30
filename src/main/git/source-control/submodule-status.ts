import type { GitStatusEntry, GitStatusResult } from '../../../shared/git-status-types'
import { capGitStatusEntries, resolveGitStatusLimit } from '../../../shared/git-status-limit'
import { gitChangeListArgs, parseGitChangeList } from '../../../shared/git-change-list'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { getStatus } from './status-read'
import { resolveSubmoduleWorktreePath } from './submodule-paths'
import {
  readGitlinkOidFromIndex,
  readGitlinkOidFromTree,
  readWorkingSubmoduleHead
} from './submodule-gitlink-oid'

/** Return submodule-relative entries; the renderer supplies the parent prefix. */
export async function getSubmoduleStatus(
  worktreePath: string,
  submodulePath: string,
  options: GetStatusOptions & { staged?: boolean } = {}
): Promise<GitStatusResult> {
  const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
  const limit = resolveGitStatusLimit(options.limit)
  // Read independent inputs concurrently; staged expansion needs HEAD/index only, not inner status.
  const [workingResult, fromOid, toOid] = await Promise.all([
    options.staged
      ? Promise.resolve<GitStatusResult>({ entries: [], conflictOperation: 'unknown' })
      : getStatus(submoduleWorktreePath, options),
    // A clean moved gitlink still needs committed range rows.
    options.staged
      ? readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
      : readGitlinkOidFromIndex(worktreePath, submodulePath, options).then(
          (indexOid) =>
            indexOid || readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
        ),
    options.staged
      ? readGitlinkOidFromIndex(worktreePath, submodulePath, options)
      : readWorkingSubmoduleHead(submoduleWorktreePath, options)
  ])
  if (fromOid && toOid && fromOid !== toOid) {
    const rangeEntries = await computeSubmoduleRangeEntries(
      submoduleWorktreePath,
      fromOid,
      toOid,
      options
    )
    if (options.staged) {
      return { ...workingResult, ...capGitStatusEntries(rangeEntries, limit) }
    }
    const rangePaths = new Set(rangeEntries.map((entry) => entry.path))
    // Range rows win on overlap so the diff matches getDiff's commit-range route.
    const entries = [
      ...rangeEntries,
      ...workingResult.entries.filter((entry) => !rangePaths.has(entry.path))
    ]
    return {
      ...workingResult,
      ...capGitStatusEntries(entries, limit, workingResult)
    }
  }
  if (options.staged) {
    return { ...workingResult, entries: [] }
  }
  return workingResult
}

async function computeSubmoduleRangeEntries(
  submoduleWorktreePath: string,
  fromOid: string,
  toOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitStatusEntry[]> {
  const gitOptions = {
    ...gitOptionsForWorktree(submoduleWorktreePath, options),
    env: gitOptionalLocksDisabledEnv()
  }
  try {
    const { stdout } = await gitExecFileAsync(gitChangeListArgs(fromOid, toOid), gitOptions)
    return parseGitChangeList(stdout).map((entry) => ({ ...entry, area: 'unstaged' }))
  } catch {
    return []
  }
}
