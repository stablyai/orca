// Why: every Kanban HTTP path (client reads, mark-started writes) must mark
// the stored connection invalid on 401/403 so `getStatus` reports
// `reason: 'invalid'` and the Task Page offers reconnect, not a half-built list.
let authInvalidated = false

export function invalidateKanbanAuth(): void {
  authInvalidated = true
}

export function isKanbanAuthInvalidated(): boolean {
  return authInvalidated
}

export function resetKanbanAuthInvalidation(): void {
  authInvalidated = false
}