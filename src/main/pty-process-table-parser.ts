export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** Foreground process group of the row's terminal; 0 or -1 without one. */
  tpgid?: number
  /** Verbatim lstart; delayed SIGKILL also requires matching pgid and an unambiguous capture boundary. */
  startedAt: string
}

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of psOutput.split('\n')) {
    // lstart contains spaces, so only the leading numeric columns are positional; tpgid is optional.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(-?\d+)\s+)?(\D.*?)\s*$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      ...(match[4] === undefined ? {} : { tpgid: Number(match[4]) }),
      startedAt: match[5]
    })
  }
  return rows
}
