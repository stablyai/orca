import type { GitDiffResult } from '../../../../shared/git/diff/git-diff-compare-types'
import type { GitDiffReadOptions } from '../../command-runner/git-runtime-options'
import { dedupeGitDiffRead } from '../git-read-cache-invalidation'
import { buildDiffResult } from '../diffs/diff-result'
import { blobConversion, readGitBlobAtOidPath } from '../diffs/git-blob-read'

export async function getBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitDiffReadOptions = {}
): Promise<GitDiffResult> {
  return dedupeGitDiffRead(
    ['branchDiff', worktreePath, args.headOid, args.mergeBase, args.filePath, args.oldPath ?? null],
    options,
    () => loadBranchDiff(worktreePath, args, options)
  )
}

async function loadBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitDiffReadOptions
): Promise<GitDiffResult> {
  try {
    const leftPath = args.oldPath ?? args.filePath
    const conversion = blobConversion(worktreePath, args.filePath, options)
    const leftConversion =
      leftPath === args.filePath ? conversion : blobConversion(worktreePath, leftPath, options)
    // Read independent blobs concurrently to avoid doubling diff latency.
    const [leftBlob, rightBlob] = await Promise.all([
      readGitBlobAtOidPath(worktreePath, args.mergeBase, leftPath, options, leftConversion),
      readGitBlobAtOidPath(worktreePath, args.headOid, args.filePath, options, conversion)
    ])

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath,
      leftBlob.tooLarge === true || rightBlob.tooLarge === true
    )
  } catch {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}
