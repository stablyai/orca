import type { GitStatusEntry, GitStatusResult } from '../../../shared/git/status/git-status-types'
import {
  capGitStatusEntries,
  resolveGitStatusLimit
} from '../../../shared/git/status/git-status-limit'
import { gitChangeListArgs, parseGitChangeList } from '../../../shared/git/diff/git-change-list'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { describeStatusReadError, getStatus } from './status-read'
import { resolveSubmoduleWorktreePath } from './submodule-paths'
import {
  readGitlinkOidFromIndexStrict,
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
  const workingResultPromise = options.staged
    ? Promise.resolve<GitStatusResult>({ entries: [], conflictOperation: 'unknown' })
    : getStatus(submoduleWorktreePath, options)
  try {
    const [workingResult, fromOid, toOid] = await Promise.all([
      workingResultPromise,
      // A clean moved gitlink still needs committed range rows.
      options.staged
        ? readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
        : readGitlinkOidFromIndexStrict(worktreePath, submodulePath, options).then(
            (indexOid) =>
              indexOid || readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
          ),
      options.staged
        ? readGitlinkOidFromIndexStrict(worktreePath, submodulePath, options)
        : readWorkingSubmoduleHead(submoduleWorktreePath, options)
    ])
    options.signal?.throwIfAborted()
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
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    const workingResult = await workingResultPromise
    options.signal?.throwIfAborted()
    return {
      ...workingResult,
      readError: workingResult.readError ?? describeStatusReadError(error)
    }
  }
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
  const { stdout } = await gitExecFileAsync(gitChangeListArgs(fromOid, toOid), gitOptions)
  return parseGitChangeList(stdout).map((entry) => ({ ...entry, area: 'unstaged' }))
}
