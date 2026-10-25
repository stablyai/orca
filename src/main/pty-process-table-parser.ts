export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** Verbatim lstart; delayed SIGKILL also requires matching pgid and an unambiguous capture boundary. */
  startedAt: string
}

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of psOutput.split('\n')) {
    // lstart contains spaces, so only the three leading numeric columns are positional.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4]
    })
  }
  return rows
}
