import { sessionFromRecord, type TerminalHostSessionRecord } from './terminal-host-session-record'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

function checkpointTerminalHostSessions(
  sessions: ReadonlyMap<string, TerminalHostSessionRecord>,
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
): void {
  if (!onFinalCheckpoint) {
    return
  }
  for (const [sessionId, record] of sessions) {
    const session = sessionFromRecord(record)
    if (!session?.isAlive) {
      continue
    }
    const take = session.takePendingOutput(true, { teardownSnapshot: true })
    if (!take?.snapshot) {
      continue
    }
    try {
      onFinalCheckpoint(sessionId, take.snapshot, take.records)
    } catch {
      // Final checkpoints are best-effort and must not block native teardown.
    }
  }
}

async function disposeTerminalHostSessions(
  sessions: Iterable<TerminalHostSessionRecord>
): Promise<void> {
  const results = await Promise.allSettled(
    [...sessions].map(async (record) => {
      const session = sessionFromRecord(record)
      if (!session) {
        return
      }
      session.detachAllClients()
      // Why: live children retain native ownership until physical exit, while
      // exited children must release handles without signalling a recycled pid.
      if (session.isAlive) {
        await session.forceKillAndDisposeSubprocess()
      } else {
        session.disposeSubprocess()
      }
    })
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (rejected) {
    throw rejected.reason
  }
}

export async function shutdownTerminalHostSessions(
  sessions: Map<string, TerminalHostSessionRecord>,
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
): Promise<void> {
  checkpointTerminalHostSessions(sessions, onFinalCheckpoint)
  await disposeTerminalHostSessions(sessions.values())
  sessions.clear()
}
