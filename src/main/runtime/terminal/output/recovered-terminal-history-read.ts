import {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from './provider-snapshot-budget'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../../../daemon/sessions/daemon-session-scrollback-window'
import type { RuntimeHeadlessTerminal } from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalProjection } from './terminal-projection'

/** Daemon history of a terminal rebuilt after dropped output. Above the daemon's live window the
 *  full request can take seconds (durable history), so the live window is asked first: a smaller
 *  request started later would only rejoin the larger one. */
export async function readRecoveredTerminalHistory(
  rowLimit: number,
  read: (rows: number, timeoutMs: number) => Promise<RuntimeTerminalProjection>
): Promise<RuntimeTerminalProjection> {
  const liveRows = Math.min(rowLimit, DAEMON_SESSION_SCROLLBACK_ROWS)
  // Caught here: a full read that answers first leaves this one unawaited.
  const live = read(liveRows, VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS).catch(
    (): RuntimeTerminalProjection => ({ lines: [] })
  )
  if (rowLimit > liveRows) {
    const full = await read(rowLimit, AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    if (full.lines.length > 0) {
      return full
    }
  }
  // A busy terminal can outrun one snapshot; one more live read bounds the daemon work.
  for (const attempt of [live, null]) {
    const projection =
      (await attempt) ?? (await read(liveRows, VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS))
    if (projection.lines.length > 0) {
      return liveRows < rowLimit ? { ...projection, historyCut: true } : projection
    }
  }
  return { lines: [] }
}

// One warning per rebuilt model, not per read of a busy terminal.
const warned = new WeakSet<RuntimeHeadlessTerminal>()

export function warnRecoveredHistoryUnavailable(
  model: RuntimeHeadlessTerminal,
  ptyId: string
): void {
  if (!warned.has(model)) {
    warned.add(model)
    console.warn('[terminal] recovered history unavailable; reading the visible screen:', ptyId)
  }
}
