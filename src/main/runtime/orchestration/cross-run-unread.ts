import type { OrchestrationDb } from './db'

export type CrossRunUnread = {
  runId: string
  count: number
}

// Why: bound-run check can be empty while this coordinator still has unread
// current_delivery mail on an older Run. Callers that only run `check` need
// that spelled out; a silent count:0 is how #13696 trains automations to stop.
export function listCrossRunUnread(
  db: OrchestrationDb,
  coordinatorHandle: string,
  boundRunId: string
): CrossRunUnread[] {
  return db.listUnreadRunMailboxesForCoordinator(coordinatorHandle, boundRunId)
}

export function withCrossRunUnread<T extends object>(
  result: T,
  entries: CrossRunUnread[]
): T & { crossRunUnread?: CrossRunUnread[] } {
  return entries.length === 0 ? result : { ...result, crossRunUnread: entries }
}

export function boundRunAllowsPointer(db: OrchestrationDb, mailboxHandle: string): boolean {
  if (!mailboxHandle.startsWith('run:')) {
    return true
  }
  return db.getUnreadRunMailbox(mailboxHandle.slice('run:'.length), 1).length > 0
}
