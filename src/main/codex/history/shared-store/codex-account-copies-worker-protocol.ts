import type { VerifiedCopy, VerifyBudget } from './codex-account-copies'
import type { CopiesTally } from './codex-account-copies-tally'

/** One call at a time between the cleanup and its worker. */
export type CodexAccountCopiesRequest =
  | { op: 'verify'; accountHome: string; storeHome: string; budget: VerifyBudget }
  | { op: 'delete'; accountHome: string; storeHome: string; copies: VerifiedCopy[] }

export type CodexAccountCopiesResponse =
  | { ok: true; verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }
  | { ok: false; message: string }
