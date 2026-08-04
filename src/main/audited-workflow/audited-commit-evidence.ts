// Reads the Git evidence channels used by commit-attempt crash recovery.
//
// Why channels rather than a status column: a non-zero exit is NOT proof Git made
// no durable change, and a crash leaves no exit code at all. The only honest way
// to decide what happened is to look at the objects and refs Git actually holds
// and compare them to what the attempt row said was INTENDED.
import type { CommitAttemptRow } from './audited-commit-attempt-repository'
import { hashCommitMessageBody } from './audited-commit-message'
import {
  buildCatFileCommitArgv,
  buildCatFileExistsArgv,
  buildCatFileTypeArgv,
  buildRevListCountArgv,
  buildRevParseCommitArgv,
  runAuditedGitRead
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'

export type CommitEvidence = {
  /** C0: the approved tree resolves in the real store (promotion landed). */
  treePresent: boolean
  /** C1: the recorded commit object exists. */
  commitPresent: boolean
  /** C2: where the branch ref points now, or null when unreadable. */
  branchTip: string | null
  /** C3: the commit's tree, when readable. */
  commitTree: string | null
  /** C4: the commit's first parent, when readable. */
  commitParent: string | null
  /** C5: sha256 of the commit's message body, when readable. */
  commitMessageSha: string | null
  /** C6: commit count from base to the commit; 0/null means not a descendant. */
  descendantCount: number | null
}

export async function readCommitEvidence(
  worktreePath: string,
  attempt: CommitAttemptRow
): Promise<CommitEvidence> {
  const treePresent = (
    await runAuditedGitRead(buildCatFileExistsArgv(attempt.intendedTreeOid), worktreePath)
  ).ok

  const sha = attempt.createdCommitSha
  const commitPresent =
    sha !== null &&
    FULL_OID.test(sha) &&
    (await runAuditedGitRead(buildCatFileTypeArgv(sha), worktreePath)).ok

  const tipResult = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${attempt.intendedBranch}`),
    worktreePath
  )
  const branchTip =
    tipResult.ok && FULL_OID.test(tipResult.stdout.trim()) ? tipResult.stdout.trim() : null

  let commitTree: string | null = null
  let commitParent: string | null = null
  let commitMessageSha: string | null = null
  let descendantCount: number | null = null

  if (commitPresent && sha) {
    const raw = await runAuditedGitRead(buildCatFileCommitArgv(sha), worktreePath)
    if (raw.ok) {
      const parsed = parseCommitObject(raw.stdout)
      commitTree = parsed.tree
      commitParent = parsed.parent
      commitMessageSha = parsed.message === null ? null : hashCommitMessageBody(parsed.message)
    }
    const counted = await runAuditedGitRead(
      buildRevListCountArgv(attempt.intendedParent, sha),
      worktreePath
    )
    if (counted.ok) {
      const value = Number.parseInt(counted.stdout.trim(), 10)
      descendantCount = Number.isFinite(value) ? value : null
    }
  }

  return {
    treePresent,
    commitPresent,
    branchTip,
    commitTree,
    commitParent,
    commitMessageSha,
    descendantCount
  }
}

/**
 * Parses `git cat-file commit <sha>`: headers, blank line, then the message.
 */
export function parseCommitObject(raw: string): {
  tree: string | null
  parent: string | null
  message: string | null
} {
  const separator = raw.indexOf('\n\n')
  if (separator === -1) {
    return { tree: null, parent: null, message: null }
  }
  const headers = raw.slice(0, separator).split('\n')
  let tree: string | null = null
  let parent: string | null = null
  for (const line of headers) {
    if (tree === null && line.startsWith('tree ')) {
      const value = line.slice(5).trim()
      tree = FULL_OID.test(value) ? value : null
    } else if (parent === null && line.startsWith('parent ')) {
      const value = line.slice(7).trim()
      parent = FULL_OID.test(value) ? value : null
    }
  }
  return { tree, parent, message: raw.slice(separator + 2) }
}
