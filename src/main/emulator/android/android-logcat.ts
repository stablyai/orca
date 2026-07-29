// Pure arg-building and line parsing for `adb logcat`. No process execution
// here: the caller prepends the resolved adb binary path to every arg array.

// `adb -s <serial> logcat` with `-d` to dump-and-exit (vs. follow), the
// `threadtime` format always (gives pid/tid and matches the parser), an optional
// `-t <lines>` tail, and trailing filterspec tokens (e.g. ['MyTag:D', '*:S'])
// that must come last on the adb command line.
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

// Matches `MM-DD HH:MM:SS.mmm <pid> <tid> <level> <tag>: <message>`. The tag is
// every non-colon char up to the first colon, so colons in the message survive.
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
