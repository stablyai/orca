import type { JournalSqlRequest } from './journal-sql-protocol'

/** Urgent requests queue after earlier urgent ones and ahead of all bulk work. Returns whether it was urgent. */
export function enqueueJournalSqlRequest(
  queue: JournalSqlRequest[],
  request: JournalSqlRequest
): boolean {
  if (!request.urgent) {
    queue.push(request)
    return false
  }
  const bulk = queue.findIndex((queued) => !queued.urgent)
  queue.splice(bulk === -1 ? queue.length : bulk, 0, request)
  return true
}

/** A chat that starts sending lifts its writes already waiting as bulk; returns whether any moved. */
export function promoteJournalSqlSession(queue: JournalSqlRequest[], sessionId: string): boolean {
  const promoted = queue.filter(
    (request) =>
      !request.urgent &&
      request.command.type === 'write' &&
      request.command.command.target.sessionId === sessionId
  )
  if (promoted.length === 0) {
    return false
  }
  for (const request of promoted) {
    queue.splice(queue.indexOf(request), 1)
    enqueueJournalSqlRequest(queue, { ...request, urgent: true })
  }
  return true
}
