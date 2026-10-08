import type { RuntimeWorktreePsSummary } from '../shared/runtime-types'

type TerminalCounts = Pick<
  RuntimeWorktreePsSummary,
  'liveTerminalCount' | 'hasAttachedPty' | 'unverifiableTerminalCount'
>

/** `none`: the host reports no terminal for the row. Never `exited`, which needs proof of an exit. */
type TerminalVerdict = 'live' | 'unverifiable' | 'none'

function terminalVerdict(row: TerminalCounts): TerminalVerdict {
  if (row.liveTerminalCount > 0) {
    return 'live'
  }
  // Absent count: a host that predates it, which cannot tell no terminals from lost contact.
  if (row.unverifiableTerminalCount === undefined || row.unverifiableTerminalCount > 0) {
    return 'unverifiable'
  }
  return 'none'
}

/** `live:` and `pty:` words for one row; lost contact never reads as zero or no. */
export function formatWorktreePsTerminalFields(row: TerminalCounts): string {
  if (terminalVerdict(row) === 'unverifiable') {
    return 'live:unverifiable  pty:unverifiable'
  }
  const unverifiable = row.unverifiableTerminalCount ?? 0
  if (unverifiable === 0) {
    return `live:${row.liveTerminalCount}  pty:${row.hasAttachedPty ? 'yes' : 'no'}`
  }
  return `live:${row.liveTerminalCount}+${unverifiable} unverifiable  pty:${row.hasAttachedPty ? 'yes' : 'unverifiable'}`
}

/**
 * JSON counterpart. The count fields keep their number/boolean types for existing scripts, so
 * `terminalVerdict` is what says a 0/false came from a host that could not be asked.
 */
export function projectWorktreePsTerminalVerdict<TRow extends TerminalCounts>(
  row: TRow
): TRow & { terminalVerdict: TerminalVerdict } {
  return { ...row, terminalVerdict: terminalVerdict(row) }
}
