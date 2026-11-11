// Apply account defaults only to this phone’s new chats before their first live options report.

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

export function mobileCreatedStructuredSession(
  sessionId: string
): { worktree: string } | undefined {
  return created.get(sessionId)
}

export function forgetMobileCreatedStructuredSession(sessionId: string): void {
  created.delete(sessionId)
}
