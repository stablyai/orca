import type { GitStatusEntry, GitStatusResult } from '../../../shared/git-status-types'
import { capGitStatusEntries, resolveGitStatusLimit } from '../../../shared/git-status-limit'
import { parseNumstat } from '../../../shared/git-uncommitted-line-stats'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { getStatus } from './status-read'
import { resolveSubmoduleWorktreePath } from './submodule-paths'
import { parseBranchChangeLine } from './branch-change-entries'
import {
  readGitlinkOidFromIndex,
  readGitlinkOidFromTree,
  readWorkingSubmoduleHead
} from './submodule-gitlink-oid'

/**
 * Run a plain status inside a submodule's own worktree (lazy "expand submodule"
 * flow). Entry paths are relative to the submodule root; the renderer prefixes them.
 */
export async function getSubmoduleStatus(
  worktreePath: string,
  submodulePath: string,
  options: GetStatusOptions & { staged?: boolean } = {}
): Promise<GitStatusResult> {
  const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
  const limit = resolveGitStatusLimit(options.limit)
  // Why: staged expansion only represents HEAD→index; scanning the submodule worktree is wasted work.
  const workingResult = options.staged
    ? ({ entries: [], conflictOperation: 'unknown' } satisfies GitStatusResult)
    : await getStatus(submoduleWorktreePath, options)
  // Why: a moved gitlink (clean worktree) has no status rows; surface the parent-commit→checkout range as inner rows.
  const fromOid = options.staged
    ? await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    : (await readGitlinkOidFromIndex(worktreePath, submodulePath, options)) ||
      (await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options))
  const toOid = options.staged
    ? await readGitlinkOidFromIndex(worktreePath, submodulePath, options)
    : await readWorkingSubmoduleHead(submoduleWorktreePath, options)
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

/**
 * List files changed between two submodule commits as status rows — used when a
 * gitlink pointer moved so the expanded submodule shows committed changes.
 */
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
  let nameStatus = ''
  let numstat = ''
  try {
    const [statusResult, numstatResult] = await Promise.all([
      gitExecFileAsync(
        ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', fromOid, toOid],
        gitOptions
      ),
      gitExecFileAsync(
        ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', '-C', fromOid, toOid],
        gitOptions
      )
    ])
    nameStatus = statusResult.stdout
    numstat = numstatResult.stdout
  } catch {
    return []
  }
  const statsByPath = parseNumstat(numstat)
  const entries: GitStatusEntry[] = []
  for (const line of nameStatus.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const change = parseBranchChangeLine(line)
    if (!change) {
      continue
    }
    entries.push({
      path: change.path,
      status: change.status,
      area: 'unstaged',
      ...(change.oldPath ? { oldPath: change.oldPath } : {}),
      ...statsByPath.get(change.path)
    })
  }
  return entries
}
