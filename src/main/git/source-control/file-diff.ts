import * as path from 'node:path'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { resolveWorktreeHostPath } from '../../../shared/git-metadata-path'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe, settledDiffCache } from './git-read-cache-invalidation'
import { readWorktreeDiffStamp } from './worktree-diff-stamp'
import { buildDiffResult } from './diff-result'
import {
  type GitBlobReadResult,
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
  const readKey = stableInFlightKey([
    'diff',
    worktreePath,
    filePath,
    staged,
    compareAgainstHead,
    ...gitRuntimeOptionsKey(options)
  ])
  // Why: register the dedupe synchronously (before any await) so concurrent identical reads
  // coalesce — including on the settled-cache lookup, which is itself I/O.
  return gitDiffReadDedupe.run(readKey, () =>
    loadDiffThroughSettledCache(
      readKey,
      worktreePath,
      filePath,
      staged,
      compareAgainstHead,
      options
    )
  )
}

/**
 * Serve a settled diff when the git state it was built from is provably
 * unchanged, otherwise read and — only if the read proved everything it touched
 * — record it under the stamp taken *before* the read.
 *
 * Stamping first is what makes staleness impossible: anything that moves during
 * or after the read leaves the stored stamp behind, so the next lookup misses.
 */
async function loadDiffThroughSettledCache(
  readKey: string,
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  // Why before the stamp read: the stamp is itself several awaited stats, and a mutation that
  // lands entirely inside that window would otherwise leave the fence covering only the git read.
  const readGeneration = settledDiffCache.beginRead()
  // A staged diff compares HEAD to the index, so the working tree is not one of its inputs.
  const stamp = await readWorktreeDiffStamp(worktreePath, filePath, !staged, options)
  const cached = settledDiffCache.get(readKey, stamp)
  if (cached) {
    return cached
  }
  const loaded = await loadDiff(worktreePath, filePath, staged, compareAgainstHead, options)
  if (loaded.reusable) {
    settledDiffCache.set(readKey, stamp, loaded.result, readGeneration)
  }
  return loaded.result
}

/**
 * `reusable` is false when the result cannot be proven to describe the stamped
 * state: a submodule route, whose inputs live in another repo and are stamped by
 * that repo's own read, or a blob read that failed rather than proving absence.
 */
type LoadedDiff = { result: GitDiffResult; reusable: boolean }

async function loadDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions
): Promise<LoadedDiff> {
  // Why: gitlink paths can't be read as blobs, so route submodule diffs explicitly (root → pointer, inner → recurse).
  const submodulePaths = await listSubmodulePaths(worktreePath, options)
  if (submodulePaths.length > 0) {
    const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
    if (matchedSubmodule) {
      // Why: validate the .gitmodules-derived path against the worktree boundary so a crafted one can't escape the repo.
      const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, matchedSubmodule)
      const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
      if (normalizedFilePath === matchedSubmodule) {
        return notReusable(
          await buildSubmodulePointerDiff(
            worktreePath,
            matchedSubmodule,
            staged,
            compareAgainstHead,
            options,
            submoduleWorktreePath
          )
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
        return notReusable(
          await buildSubmoduleInnerCommitRangeDiff(
            submoduleWorktreePath,
            innerPath,
            fromOid,
            toOid,
            options
          )
        )
      }
      // The inner read stamps and caches against the submodule's own repo state.
      return notReusable(
        await getDiff(submoduleWorktreePath, innerPath, staged, compareAgainstHead, options)
      )
    }
  }

  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false
  let modifiedDeleted = false
  let readFailed = false

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
      readFailed = leftBlob.failed === true || rightBlob.failed === true
    } else {
      // The left chain (index→HEAD) is sequential within itself, but the working
      // tree read is a plain fs read that does not depend on it.
      // Git can run in the distro against a raw Linux worktree path while Node reads it through Win32.
      const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options)
      const [leftBlob, workingTreeBlob] = await Promise.all([
        compareAgainstHead
          ? readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
          : readUnstagedLeftBlob(worktreePath, filePath, options),
        hostWorktreePath
          ? readWorkingTreeFile(path.join(hostWorktreePath, filePath))
          : Promise.resolve(UNSPELLABLE_WORKING_TREE_READ)
      ])
      originalContent = leftBlob.content
      originalIsBinary = leftBlob.isBinary
      modifiedContent = workingTreeBlob.content
      modifiedIsBinary = workingTreeBlob.isBinary
      modifiedDeleted = !workingTreeBlob.exists
      readFailed = leftBlob.failed === true || workingTreeBlob.failed === true
    }
  } catch {
    // Fallback
    readFailed = true
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
    return { result: { ...result, modifiedDeleted: true }, reusable: !readFailed }
  }
  return { result, reusable: !readFailed }
}

/** A worktree path with no host spelling is a read failure, never a proven deletion. */
const UNSPELLABLE_WORKING_TREE_READ: GitBlobReadResult = {
  content: '',
  isBinary: false,
  exists: true,
  failed: true
}

function notReusable(result: GitDiffResult): LoadedDiff {
  return { result, reusable: false }
}
