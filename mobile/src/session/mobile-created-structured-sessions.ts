// Structured chats this phone created and that have not yet answered live, as the desktop latches
// its own launches: only a new chat runs the account's configured model, so only its first frame may
// name it.

const CREATED_LIMIT = 32

const created = new Map<string, { worktree: string }>()

export function rememberMobileCreatedStructuredSession(sessionId: string, worktree: string): void {
  created.delete(sessionId)
  created.set(sessionId, { worktree })
  for (const oldest of created.keys()) {
    if (created.size <= CREATED_LIMIT) {
      break
    }
    created.delete(oldest)
  }
}

/** The chat's workspace selector when this phone created it, else undefined. */
export function mobileCreatedStructuredSession(
  sessionId: string
): { worktree: string } | undefined {
  return created.get(sessionId)
}

/** The chat answered live, so a reopened view reads its options rather than the listed default. */
export function forgetMobileCreatedStructuredSession(sessionId: string): void {
  created.delete(sessionId)
}
