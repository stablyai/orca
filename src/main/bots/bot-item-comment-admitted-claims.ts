import type { BotItemsRemote } from './bot-items-ops'

// An owner comment's admission claims its uploads for the item's chat; the mail that follows to that
// same chat need not claim them again. Kept per open items store, so a reopened store (a restart) claims again.
const admitted = new WeakMap<BotItemsRemote, Set<string>>()
const ADMITTED_CLAIMS_MAX = 64

export type AdmittedCommentClaim = { sessionId: string; uploadIds: ReadonlySet<string> }

function claimKey(eventId: number, { sessionId, uploadIds }: AdmittedCommentClaim): string {
  return [eventId, sessionId, ...[...uploadIds].sort()].join('\n')
}

export function rememberAdmittedCommentClaim(
  store: BotItemsRemote,
  eventId: number,
  claim: AdmittedCommentClaim
): void {
  let claims = admitted.get(store)
  if (!claims) {
    claims = new Set()
    admitted.set(store, claims)
  }
  claims.add(claimKey(eventId, claim))
  // Admissions whose mail never went out (a deleted chat) age out oldest first.
  for (const key of claims) {
    if (claims.size <= ADMITTED_CLAIMS_MAX) {
      break
    }
    claims.delete(key)
  }
}

/** True once when this store's admission of comment `eventId` claimed exactly these uploads for `sessionId`. */
export function takeAdmittedCommentClaim(
  store: BotItemsRemote,
  eventId: number,
  claim: AdmittedCommentClaim
): boolean {
  return admitted.get(store)?.delete(claimKey(eventId, claim)) ?? false
}
