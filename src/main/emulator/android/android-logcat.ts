// Filters must follow all logcat options; threadtime matches the line parser below.
export function logcatArgs(
  serial: string,
  options?: { dump?: boolean; lines?: number; filters?: readonly string[] }
): string[] {
  const args = ['-s', serial, 'logcat']
  if (options?.dump) {
    args.push('-d')
  }
  args.push('-v', 'threadtime')
  if (options?.lines !== undefined) {
    args.push('-t', String(options.lines))
  }
  if (options?.filters) {
    args.push(...options.filters)
  }
  return args
}

export type LogcatEntry = { timestamp?: string; level?: string; tag?: string; message: string }

// Match only the first colon so colons inside messages survive.
const LOGCAT_LINE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+\d+\s+\d+\s+([A-Z])\s+([^:]+):(.*)$/

export function parseLogcatLine(line: string): LogcatEntry {
  const trimmed = line.trim()
  const match = LOGCAT_LINE.exec(trimmed)
  if (!match) {
    return { message: trimmed }
  }
  return {
    timestamp: match[1],
    level: match[2],
    tag: match[3].trim(),
    message: match[4].trim()
  }
}
