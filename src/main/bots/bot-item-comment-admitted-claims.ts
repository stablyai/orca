// An owner comment's admission claims its uploads for the item's chat; the mail that follows to that
// same chat need not claim them again. Kept per open items store, so a reopened store (a restart) claims again.
const admitted = new WeakMap<object, Set<string>>()
const ADMITTED_CLAIMS_MAX = 64

export type AdmittedCommentClaim = { sessionId: string; uploadIds: ReadonlySet<string> }

function claimKey({ sessionId, uploadIds }: AdmittedCommentClaim): string {
  return [sessionId, ...[...uploadIds].sort()].join('\n')
}

export function rememberAdmittedCommentClaim(store: object, claim: AdmittedCommentClaim): void {
  let claims = admitted.get(store)
  if (!claims) {
    claims = new Set()
    admitted.set(store, claims)
  }
  claims.add(claimKey(claim))
  // Admissions whose mail never went out (a deleted chat) age out oldest first.
  for (const key of claims) {
    if (claims.size <= ADMITTED_CLAIMS_MAX) {
      break
    }
    claims.delete(key)
  }
}

/** True once when this store's admission already claimed exactly these uploads for `sessionId`. */
export function takeAdmittedCommentClaim(store: object, claim: AdmittedCommentClaim): boolean {
  return admitted.get(store)?.delete(claimKey(claim)) ?? false
}
