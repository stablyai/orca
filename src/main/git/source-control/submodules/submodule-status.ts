import { lstat } from 'node:fs/promises'
import * as path from 'node:path'

import type {
  GitStatusEntry,
  GitStatusResult
} from '../../../../shared/git/status/git-status-types'
import {
  capGitStatusEntries,
  resolveGitStatusLimit
} from '../../../../shared/git/status/git-status-limit'
import { gitChangeListArgs, parseGitChangeList } from '../../../../shared/git/diff/git-change-list'
import { resolveWorktreeHostPath } from '../../../../shared/git/metadata/git-metadata-path'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitOptionalLocksDisabledEnv } from '../../command-runner/git-environment/git-process-env'
import type { GetStatusOptions } from '../status/get-status-options'
import { getStatus } from '../status/status-read'
import { resolveSubmoduleWorktreePath } from './submodule-paths'
import {
  readGitlinkOidFromIndex,
  readGitlinkOidFromTree,
  readWorkingSubmoduleHead
} from './submodule-gitlink-oid'

export type GetSubmoduleStatusOptions = GetStatusOptions & {
  staged?: boolean
  /** Read only the submodule's working tree (line stats off), without committed gitlink range rows. */
  workingTreeOnly?: boolean
}

/** An uninitialized submodule directory has no `.git`; running Git there would walk up to the parent repo. */
async function isSubmoduleCheckedOut(
  submoduleWorktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  const hostPath = resolveWorktreeHostPath(submoduleWorktreePath, options) ?? submoduleWorktreePath
  try {
    await lstat(path.join(hostPath, '.git'))
    return true
  } catch {
    return false
  }
}

/** Return submodule-relative entries; the renderer supplies the parent prefix. */
export async function getSubmoduleStatus(
  worktreePath: string,
  submodulePath: string,
  options: GetSubmoduleStatusOptions = {}
): Promise<GitStatusResult> {
  const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
  if (!(await isSubmoduleCheckedOut(submoduleWorktreePath, options))) {
    return { entries: [], conflictOperation: 'unknown' }
  }
  if (options.workingTreeOnly && !options.staged) {
    return getStatus(submoduleWorktreePath, {
      ...options,
      includeLineStats: false
    })
  }
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
