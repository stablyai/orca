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

type FileDiffOptions = GitRuntimeOptions & { oldPath?: string }

export async function getDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead = false,
  options: FileDiffOptions = {}
): Promise<GitDiffResult> {
  const readKey = stableInFlightKey([
    'diff',
    worktreePath,
    filePath,
    staged,
    compareAgainstHead,
    staged ? (options.oldPath ?? null) : null,
    ...gitRuntimeOptionsKey(options)
  ])
  // Register before any await so concurrent reads also coalesce settled-cache lookup I/O.
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

/** Reuse only proven inputs; stamp before reading so later state changes invalidate the cached result. */
async function loadDiffThroughSettledCache(
  readKey: string,
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: FileDiffOptions
): Promise<GitDiffResult> {
  // Start the mutation fence before awaited stats so writes during stamp collection also invalidate the read.
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

/** Submodule routes and failed blob reads cannot prove this repo's stamped state reusable. */
type LoadedDiff = { result: GitDiffResult; reusable: boolean }

async function loadDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: FileDiffOptions
): Promise<LoadedDiff> {
  // Gitlinks are not blobs: route root paths to pointer diffs and inner paths to submodule reads.
  const submodulePaths = await listSubmodulePaths(worktreePath, options)
  if (submodulePaths.length > 0) {
    const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
    if (matchedSubmodule) {
      // Validate .gitmodules paths so crafted entries cannot escape the worktree.
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
      // A moved gitlink represents committed changes even when the submodule worktree is clean.
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
        await getDiff(submoduleWorktreePath, innerPath, staged, compareAgainstHead, {
          ...options,
          oldPath: undefined
        })
      )
    }
  }

  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false
  let modifiedDeleted = false
  let readFailed = false
  let tooLarge = false

  try {
    if (staged) {
      // HEAD and index blobs are independent; read them concurrently.
      const [leftBlob, rightBlob] = await Promise.all([
        readGitBlobAtOidPath(worktreePath, 'HEAD', options.oldPath ?? filePath, options),
        readGitBlobAtIndexPath(worktreePath, filePath, options)
      ])
      originalContent = leftBlob.content
      originalIsBinary = leftBlob.isBinary
      modifiedContent = rightBlob.content
      modifiedIsBinary = rightBlob.isBinary
      modifiedDeleted = !rightBlob.exists && !rightBlob.failed
      readFailed = leftBlob.failed === true || rightBlob.failed === true
      tooLarge = leftBlob.tooLarge === true || rightBlob.tooLarge === true
    } else {
      // The index-to-HEAD fallback is sequential internally, but independent of the working-tree read.
      // WSL Git can use a Linux cwd while Node needs its Win32 spelling.
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
      tooLarge = leftBlob.tooLarge === true || workingTreeBlob.tooLarge === true
    }
  } catch {
    readFailed = true
  }

  const result = buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    filePath,
    tooLarge
  )
  // Mark proven deletions so previewers can distinguish them from failed empty reads.
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
