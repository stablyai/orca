export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** Foreground process group of the row's terminal; 0 or -1 without one. */
  tpgid?: number
  zombie?: true
  /** Verbatim lstart; delayed SIGKILL also requires matching pgid and an unambiguous capture boundary. */
  startedAt: string
}

export function parseProcessTable(
  psOutput: string,
  options: { stat?: true } = {}
): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of psOutput.split('\n')) {
    if (!line.trim()) {
      continue
    }
    // lstart contains spaces, so only the leading numeric columns are positional; tpgid is optional.
    const match = line.match(
      options.stat
        ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\D.*?)\s*$/
        : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(-?\d+)\s+)?(\D.*?)\s*$/
    )
    if (
      !match ||
      (options.stat &&
        (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/.test(match[6]) ||
          !Number.isFinite(Date.parse(match[6]))))
    ) {
      if (options.stat) {
        throw new Error('Descendant process table is unreadable')
      }
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      ...(match[4] === undefined ? {} : { tpgid: Number(match[4]) }),
      ...(options.stat && match[5].startsWith('Z') ? { zombie: true as const } : {}),
      startedAt: match[options.stat ? 6 : 5]
    })
  }
  return rows
}
