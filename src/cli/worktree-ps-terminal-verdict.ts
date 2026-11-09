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

/** Preserve numeric/boolean fields for existing scripts; terminalVerdict distinguishes unknown values. */
export function projectWorktreePsTerminalVerdict<TRow extends TerminalCounts>(
  row: TRow
): TRow & { terminalVerdict: TerminalVerdict } {
  return { ...row, terminalVerdict: terminalVerdict(row) }
}
