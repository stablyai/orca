import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe } from './git-read-cache-invalidation'
import { buildDiffResult } from './diff-result'
import { readGitBlobAtOidPath, type GitBlobReadResult } from './git-blob-read'

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
  try {
    const leftPath = args.oldPath ?? args.filePath
    // Read independent blobs concurrently; root commits have no parent blob.
    const [leftBlob, rightBlob] = await Promise.all([
      args.parentOid
        ? readGitBlobAtOidPath(worktreePath, args.parentOid, leftPath, options)
        : Promise.resolve<GitBlobReadResult>({ content: '', isBinary: false, exists: false }),
      readGitBlobAtOidPath(worktreePath, args.commitOid, args.filePath, options)
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
