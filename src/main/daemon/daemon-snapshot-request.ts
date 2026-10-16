import { performance } from 'node:perf_hooks'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { TerminalHost } from './terminal-host'

export async function readDaemonSessionSnapshot(
  host: Pick<TerminalHost, 'getSettledSnapshot'>,
  sessionId: string,
  requestedRows: unknown
): Promise<unknown> {
  const startedAt = performance.now()
  const scrollbackRows =
    typeof requestedRows === 'number' && Number.isFinite(requestedRows)
      ? Math.max(0, Math.min(50_000, Math.floor(requestedRows)))
      : undefined
  const snapshot = await host.getSettledSnapshot(sessionId, { scrollbackRows })
  const snapshotMs = performance.now() - startedAt
  if (snapshotMs >= 25) {
    recordDaemonStreamBacklogEvent('slowGetSnapshot', {
      sessionIdSuffix: sessionId.slice(-10),
      snapshotMs: Math.round(snapshotMs)
    })
  }
  return { snapshot }
}
