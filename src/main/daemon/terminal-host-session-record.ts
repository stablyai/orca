import type { Session } from './session'

/** Only the host-observed result survives the operational session. */
export type ExitedSession = { incarnationId: string; code: number }

export type TerminalHostSessionRecord = Session | ExitedSession

// A host retains at most this many unconsumed exits, regardless of client availability.
export const MAX_EXIT_RECEIPTS = 1024

function pruneExitReceipts(records: Map<string, TerminalHostSessionRecord>): void {
  if (records.size <= MAX_EXIT_RECEIPTS) {
    return
  }
  let excess = -MAX_EXIT_RECEIPTS
  for (const record of records.values()) {
    if ('code' in record) {
      excess++
    }
  }
  for (const [id, record] of records) {
    if (excess <= 0) {
      break
    }
    if ('code' in record) {
      records.delete(id)
      excess--
    }
  }
}

export function consumeExitReceipt(
  records: Map<string, TerminalHostSessionRecord>,
  sessionId: string,
  incarnationId: string
): void {
  const record = records.get(sessionId)
  if (record && 'code' in record && record.incarnationId === incarnationId) {
    records.delete(sessionId)
  }
}

export function reapSessionRecord(
  records: Map<string, TerminalHostSessionRecord>,
  sessionId: string
): boolean {
  const session = sessionFromRecord(records.get(sessionId))
  if (!session || session.isAlive) {
    return false
  }
  const exit = session.killRequested ? undefined : exitFromRecord(session)
  session.dispose()
  if (records.get(sessionId) !== session) {
    return false
  }
  if (exit) {
    // Reinsert so receipt order follows exit time, not process creation time.
    records.delete(sessionId)
    records.set(sessionId, exit)
    pruneExitReceipts(records)
  } else {
    records.delete(sessionId)
  }
  return true
}

export function exitFromRecord(
  record: TerminalHostSessionRecord | undefined
): ExitedSession | undefined {
  // Exit broadcast precedes reaping, so a reentrant reader can still see the exited Session.
  if (record && 'code' in record) {
    return record
  }
  return record && !record.isAlive && record.exitCode !== null
    ? { incarnationId: record.incarnationId, code: record.exitCode }
    : undefined
}

export function sessionFromRecord(
  record: TerminalHostSessionRecord | undefined
): Session | undefined {
  return record && 'isAlive' in record ? record : undefined
}
