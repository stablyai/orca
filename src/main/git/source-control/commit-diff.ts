import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import { createGitCompareOptions, type GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe } from './git-read-cache-invalidation'
import { buildDiffResult } from './diff-result'
import { readGitBlobAtOidPath } from './git-blob-read'

export async function getCommitDiff(
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'commitDiff',
      worktreePath,
      args.commitOid,
      args.parentOid ?? null,
      args.filePath,
      args.oldPath ?? null,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadCommitDiff(worktreePath, args, options)
  )
}

async function loadCommitDiff(
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  const compareOptions = createGitCompareOptions(options)
  try {
    const leftPath = args.oldPath ?? args.filePath
    // Why concurrent: the two sides are independent `git show` spawns. A root
    // commit has no parent to read, so that side resolves without a spawn.
    const [leftBlob, rightBlob] = await Promise.all([
      args.parentOid
        ? readGitBlobAtOidPath(worktreePath, args.parentOid, leftPath, compareOptions)
        : Promise.resolve({ content: '', isBinary: false }),
      readGitBlobAtOidPath(worktreePath, args.commitOid, args.filePath, compareOptions)
    ])

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath
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
