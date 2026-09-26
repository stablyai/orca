import type { RuntimeTerminalHistory, RuntimeTerminalRead } from '../../shared/runtime-types'
import { terminalReadLimit } from './terminal-tail-read'

/** Tail size an agent gets when it asks for history without naming one. */
export const DEFAULT_TERMINAL_HISTORY_TAIL_LINES = 200

export function terminalHistoryTailLines(tailLines: number | undefined): number {
  return terminalReadLimit(tailLines, DEFAULT_TERMINAL_HISTORY_TAIL_LINES)
}

/**
 * Flattens a `terminal.read` result into the single ANSI-free string an agent pastes into its
 * context. Escape stripping already happened at ingest (`normalizeTerminalChunk`), so this only
 * joins retained rows — it must never re-parse, because a second pass would eat the line controls
 * the retained tail deliberately keeps.
 */
export function buildTerminalHistory(read: RuntimeTerminalRead): RuntimeTerminalHistory {
  return {
    handle: read.handle,
    status: read.status,
    history: read.tail.join('\n'),
    lineCount: read.tail.length,
    // Either cap hides older rows, and an agent reading a stack trace has to know whether it holds the top of it.
    truncated: read.truncated || read.limited === true,
    ...(read.source ? { source: read.source } : {})
  }
}
