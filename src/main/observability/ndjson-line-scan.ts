/** Newest-first line walk over an NDJSON buffer. Shared by the bundle collector
 *  and the crash-reporting trace-tail scan: both want the most recent records
 *  under a budget, and both must tolerate the half-line a crash leaves behind. */
export function* readLinesNewestFirst(text: string): Iterable<string> {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1)
    const rawLine = text.slice(start + 1, end)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length > 0) {
      yield line
    }
    if (start === -1) {
      break
    }
    end = start
  }
}
