import type { VerifyBudget } from './codex-account-copies'
import type { VerifiedCopy } from './codex-account-copies-delete'
import type { CopiesTally } from './codex-account-copies-tally'

/** One call at a time between the cleanup and its worker: verify a home, then delete in batches. */
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
      op: 'delete'
      accountHome: string
      storeHome: string
      copies: VerifiedCopy[]
      /** Codex's thread-writer-locks folders whose coordination the caller holds right now. */
      lockFolders: string[]
    }
  /** Copies kept for an ACL: later launches skip them until either file changes. */
  | { op: 'remember-acl'; accountHome: string; copies: VerifiedCopy[] }
  /** Removes the folders this run's deletes emptied, once per home after its batches. */
  | { op: 'prune'; accountHome: string; storeHome: string }

export type CodexAccountCopiesResponse =
  | { ok: true; op: 'verify'; verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }
  | { ok: true; op: 'delete'; tally: CopiesTally }
  | { ok: true; op: 'prune' }
  | { ok: true; op: 'remember-acl' }
  | { ok: false; message: string }
