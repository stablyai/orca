import type { Session } from './session'

/** Only the host-observed result survives the operational session. */
export type ExitedSession = { incarnationId: string; code: number }

export type TerminalHostSessionRecord = Session | ExitedSession

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
    records.set(sessionId, exit)
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
