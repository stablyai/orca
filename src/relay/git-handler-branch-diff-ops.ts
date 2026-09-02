import { buildDiffResult } from './git-diff-result'
import { readBlobAtOid, type GitBufferExec } from './git-handler-ops'

const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

function assertFullGitObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !FULL_GIT_OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a full git object id`)
  }
}

export function isFullGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && FULL_GIT_OBJECT_ID_PATTERN.test(value)
}

export function parseOptionalBranchDiffHeadOid(
  params: Record<string, unknown>
): string | undefined {
  const { headOid } = params
  // Why: GitBranchCompareSummary.headOid is `string | null`, so a mixed-version
  // client can put an explicit null on the wire. Treat it as unpinned rather
  // than rejecting a request the legacy path would have served.
  if (headOid == null) {
    return undefined
  }
  assertFullGitObjectId(headOid, 'headOid')
  return headOid
}

export async function branchDiffEntryAtPinnedOids(
  gitBuffer: GitBufferExec,
  worktreePath: string,
  baseOid: string,
  headOid: string,
  filePath: string,
  oldPath?: string
) {
  assertFullGitObjectId(baseOid, 'baseRef')
  assertFullGitObjectId(headOid, 'headOid')
  try {
    const [left, right] = await Promise.all([
      readBlobAtOid(gitBuffer, worktreePath, baseOid, oldPath ?? filePath),
      readBlobAtOid(gitBuffer, worktreePath, headOid, filePath)
    ])
    return [buildDiffResult(left.content, right.content, left.isBinary, right.isBinary, filePath)]
  } catch {
    return [
      {
        kind: 'text' as const,
        originalContent: '',
        modifiedContent: '',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    ]
  }
}
