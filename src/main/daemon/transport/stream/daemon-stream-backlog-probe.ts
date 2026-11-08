/** Set ORCA_DAEMON_STREAM_BACKLOG_FILE to append queue and socket diagnostics as JSONL. */
import { appendFileSync } from 'node:fs'

export type StreamBacklogClientSample = {
  clientId: string
  socketBufferedBytes: number
  batcherQueuedChars: number
}

export type StreamBacklogSample = {
  clients: StreamBacklogClientSample[]
  backgroundedSessionIdSuffixes?: string[]
}

const SAMPLE_INTERVAL_MS = 250

/** Interleave pacing changes with periodic backlog samples. */
export function recordDaemonStreamBacklogEvent(
  event: string,
  detail: Record<string, unknown>
): void {
  const filePath = process.env.ORCA_DAEMON_STREAM_BACKLOG_FILE
  if (!filePath) {
    return
  }
  try {
    appendFileSync(filePath, `${JSON.stringify({ atMs: Date.now(), event, ...detail })}\n`)
  } catch {
    // Diagnostics must never break the daemon.
  }
}

export function startDaemonStreamBacklogProbe(sample: () => StreamBacklogSample): () => void {
  const filePath = process.env.ORCA_DAEMON_STREAM_BACKLOG_FILE
  if (!filePath) {
    return () => {}
  }
  const timer = setInterval(() => {
    try {
      appendFileSync(filePath, `${JSON.stringify({ atMs: Date.now(), ...sample() })}\n`)
    } catch {
      // Diagnostics must never break the daemon.
    }
  }, SAMPLE_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
