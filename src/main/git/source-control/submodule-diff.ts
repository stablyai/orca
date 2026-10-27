import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { buildDiffResult } from './diff-result'
import { readGitBlobAtOidPath } from './git-blob-read'
import { resolveSubmoduleWorktreePath } from './submodule-paths'
import {
  readGitlinkOidFromIndex,
  readGitlinkOidFromTree,
  readWorkingSubmoduleHead
} from './submodule-gitlink-oid'

/** Feed gitlink OIDs to the text differ as Subproject commit lines. */
export async function buildSubmodulePointerDiff(
  worktreePath: string,
  submodulePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions,
  // Default to the validated resolver to prevent submodule path escape.
  submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
): Promise<GitDiffResult> {
  let leftOid = ''
  let rightOid = ''
  if (staged) {
    leftOid = await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    rightOid = await readGitlinkOidFromIndex(worktreePath, submodulePath, options)
  } else if (compareAgainstHead) {
    leftOid = await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    rightOid = await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  } else {
    leftOid =
      (await readGitlinkOidFromIndex(worktreePath, submodulePath, options)) ||
      (await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options))
    rightOid = await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  }
  return buildDiffResult(
    leftOid ? `Subproject commit ${leftOid}\n` : '',
    rightOid ? `Subproject commit ${rightOid}\n` : '',
    false,
    false,
    submodulePath
  )
}

/** Show committed inner-file changes when a clean submodule's gitlink moved. */
export async function buildSubmoduleInnerCommitRangeDiff(
  submoduleWorktreePath: string,
  innerPath: string,
  fromOid: string,
  toOid: string,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false
  try {
    const left = await readGitBlobAtOidPath(submoduleWorktreePath, fromOid, innerPath, options)
    originalContent = left.content
    originalIsBinary = left.isBinary
    const right = await readGitBlobAtOidPath(submoduleWorktreePath, toOid, innerPath, options)
    modifiedContent = right.content
    modifiedIsBinary = right.isBinary
  } catch {}
  return buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    innerPath
  )
}
