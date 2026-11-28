import type { VerifyBudget } from './codex-account-copies'
import type { VerifiedCopy } from './codex-account-copy-checks'
import type { CopiesTally } from './codex-account-copies-tally'

/**
 * One call at a time between the cleanup and its worker: per home, recheck and delete the trash
 * that waited out its grace period, then verify copies and move them to the trash in batches.
 */
export type CodexAccountCopiesRequest =
  | {
      op: 'verify'
      accountHome: string
      storeHome: string
      budget: VerifyBudget
      version: string
      managedAccountsRoot: string
    }
  | {
      op: 'trash'
      accountHome: string
      copies: VerifiedCopy[]
      /** Codex's thread-writer-locks folders whose coordination the caller holds right now. */
      lockFolders: string[]
    }
  | {
      op: 'recheck-trash'
      accountHome: string
      storeHome: string
      managedAccountsRoot: string
      maxBytes: number
      deadline: number
    }
  /** Trashed copies the recheck passed and the open check then cleared. */
  | { op: 'delete-trashed'; accountHome: string; copies: VerifiedCopy[] }
  /** Copies kept for an ACL: later launches skip them until either file changes. */
  | { op: 'remember-acl'; accountHome: string; copies: VerifiedCopy[] }
  /** Removes the folders this run's moves emptied, once per home after its batches. */
  | { op: 'prune'; accountHome: string; storeHome: string }

export type CodexAccountCopiesResponse =
  | { ok: true; op: 'verify'; verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }
  | { ok: true; op: 'trash' | 'delete-trashed'; tally: CopiesTally }
  | { ok: true; op: 'recheck-trash'; ready: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }
  | { ok: true; op: 'prune' }
  | { ok: true; op: 'remember-acl' }
  | { ok: false; message: string }
