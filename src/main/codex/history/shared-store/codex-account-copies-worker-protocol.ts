import type { VerifyBudget } from './codex-account-copies'
import type { HeldCopy, VerifiedCopy } from './codex-account-copies-hold'
import type { CopiesTally } from './codex-account-copies-tally'

/** One call at a time between the cleanup and its worker: verify, hold, then finish. */
export type CodexAccountCopiesRequest =
  | { op: 'verify'; accountHome: string; storeHome: string; budget: VerifyBudget; version: string }
  | { op: 'hold'; accountHome: string; copies: VerifiedCopy[] }
  | {
      op: 'finish'
      accountHome: string
      storeHome: string
      held: HeldCopy[]
      open: Set<string> | null
    }

export type CodexAccountCopiesResponse =
  | { ok: true; op: 'verify'; verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }
  | { ok: true; op: 'hold'; held: HeldCopy[]; tally: CopiesTally }
  | { ok: true; op: 'finish'; tally: CopiesTally }
  | { ok: false; message: string }
