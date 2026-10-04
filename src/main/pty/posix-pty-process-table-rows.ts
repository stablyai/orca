type ProcessRow = {
  pid: number
  pgid: number
  tty: string
  state?: string
  command?: string
}

export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(\S+))?(?:\s+(.+))?/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (pid > 0 && pgid > 1) {
      rows.push({ pid, pgid, tty: match[3], state: match[4], command: match[5] })
    }
  }
  return rows
}
