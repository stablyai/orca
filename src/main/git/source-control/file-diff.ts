import * as path from 'node:path'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe } from './git-read-cache-invalidation'
import { buildDiffResult } from './diff-result'
import {
  readGitBlobAtIndexPath,
  readGitBlobAtOidPath,
  readUnstagedLeftBlob,
  readWorkingTreeFile
} from './git-blob-read'
import {
  findContainingSubmodule,
  listSubmodulePaths,
  resolveSubmoduleWorktreePath
} from './submodule-paths'
import {
  readGitlinkOidFromIndex,
  readGitlinkOidFromTree,
  readWorkingSubmoduleHead
} from './submodule-gitlink-oid'
import { buildSubmoduleInnerCommitRangeDiff, buildSubmodulePointerDiff } from './submodule-diff'

/**
 * Get original and modified content for diffing a file.
 */
export async function getDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead = false,
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  // Why: register the dedupe synchronously (before any await) so concurrent identical reads coalesce.
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'diff',
      worktreePath,
      filePath,
      staged,
      compareAgainstHead,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadDiff(worktreePath, filePath, staged, compareAgainstHead, options)
  )
}

async function loadDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  // Why: gitlink paths can't be read as blobs, so route submodule diffs explicitly (root → pointer, inner → recurse).
  const submodulePaths = await listSubmodulePaths(worktreePath, options)
  if (submodulePaths.length > 0) {
    const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
    if (matchedSubmodule) {
      // Why: validate the .gitmodules-derived path against the worktree boundary so a crafted one can't escape the repo.
      const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, matchedSubmodule)
      const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
      if (normalizedFilePath === matchedSubmodule) {
        return buildSubmodulePointerDiff(
          worktreePath,
          matchedSubmodule,
          staged,
          compareAgainstHead,
          options,
          submoduleWorktreePath
        )
      }
      const innerPath = normalizedFilePath.slice(matchedSubmodule.length + 1)
      const fromOid = staged
        ? await readGitlinkOidFromTree(worktreePath, 'HEAD', matchedSubmodule, options)
        : (await readGitlinkOidFromIndex(worktreePath, matchedSubmodule, options)) ||
          (await readGitlinkOidFromTree(worktreePath, 'HEAD', matchedSubmodule, options))
      const toOid = staged
        ? await readGitlinkOidFromIndex(worktreePath, matchedSubmodule, options)
        : await readWorkingSubmoduleHead(submoduleWorktreePath, options)
      // Why: a moved gitlink with a clean submodule worktree means the change is committed — diff the two commits.
      if (fromOid && toOid && fromOid !== toOid) {
        return buildSubmoduleInnerCommitRangeDiff(
          submoduleWorktreePath,
          innerPath,
          fromOid,
          toOid,
          options
        )
      }
      return getDiff(submoduleWorktreePath, innerPath, staged, compareAgainstHead, options)
    }
  }

  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false
  let modifiedDeleted = false

  try {
    if (staged) {
      // Why concurrent: HEAD and the index are independent `git show` spawns.
      // Only this branch qualifies — the unstaged left read chains index→HEAD.
      const [leftBlob, rightBlob] = await Promise.all([
        readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options),
        readGitBlobAtIndexPath(worktreePath, filePath, options)
      ])
      originalContent = leftBlob.content
      originalIsBinary = leftBlob.isBinary
      modifiedContent = rightBlob.content
      modifiedIsBinary = rightBlob.isBinary
      modifiedDeleted = !rightBlob.exists
    } else {
      // The left chain (index→HEAD) is sequential within itself, but the working
      // tree read is a plain fs read that does not depend on it.
      const [leftBlob, workingTreeBlob] = await Promise.all([
        compareAgainstHead
          ? readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
          : readUnstagedLeftBlob(worktreePath, filePath, options),
        readWorkingTreeFile(path.join(worktreePath, filePath))
      ])
      originalContent = leftBlob.content
      originalIsBinary = leftBlob.isBinary
      modifiedContent = workingTreeBlob.content
      modifiedIsBinary = workingTreeBlob.isBinary
      modifiedDeleted = !workingTreeBlob.exists
    }
  } catch {
    // Fallback
  }

  const result = buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    filePath
  )
  // Why: mark a proven deletion so previewers don't mistake a read failure's empty side for one.
  if (result.kind === 'binary' && modifiedDeleted) {
    return { ...result, modifiedDeleted: true }
  }
  return result
}
