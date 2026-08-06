/**
 * Env-gated diagnostics for the daemon→main stream backlog: samples the
 * batcher queue and each stream socket's user-space write buffer so
 * multi-second echo lag can be attributed to the hop that actually holds the
 * bytes. Enable by setting ORCA_DAEMON_STREAM_BACKLOG_FILE to a writable
 * path; zero cost otherwise. The timer only observes and appends JSONL — it
 * never mutates delivery state.
 */
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

/** Event-level entries interleaved with the periodic samples — used to
 *  attribute WHO mutated pacing state, not just when counts changed. */
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
