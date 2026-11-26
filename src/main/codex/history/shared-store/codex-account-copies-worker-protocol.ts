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
  | { op: 'delete'; accountHome: string; storeHome: string; copies: VerifiedCopy[] }

export type CodexAccountCopiesResponse =
  | { ok: true; op: 'verify'; verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }
  | { ok: true; op: 'delete'; tally: CopiesTally }
  | { ok: false; message: string }
