import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/**
 * Reads the timing lines the phone app's latency probes print through Metro (`[lat] ...`).
 * Each line carries the phone's own clock, so Metro's delivery delay does not matter.
 */
export type PhoneProbeLog = {
  /** A position to read from later. */
  mark: () => number
  /** Probe lines written since `mark`, without the `[lat] ` prefix. */
  since: (mark: number) => string[]
}

const PROBE_TAG = '[lat] '

/** The file's bytes from `from` to the last newline, so a line Metro is still writing is left out. */
function completeLinesFrom(metroLogPath: string, from: number): { text: string; end: number } {
  const file = openSync(metroLogPath, 'r')
  try {
    const length = fstatSync(file).size - from
    if (length <= 0) {
      return { text: '', end: from }
    }
    const bytes = Buffer.alloc(length)
    readSync(file, bytes, 0, length, from)
    const lastNewline = bytes.lastIndexOf(0x0a)
    return lastNewline === -1
      ? { text: '', end: from }
      : { text: bytes.toString('utf8', 0, lastNewline), end: from + lastNewline + 1 }
  } finally {
    closeSync(file)
  }
}

export function phoneProbeLog(metroLogPath: string): PhoneProbeLog {
  let markedTo = 0
  return {
    // Why not the file size: a mark inside a half-written line would split that line's event
    // between two windows. The mark sits after the last complete line instead.
    mark: () => {
      markedTo = completeLinesFrom(metroLogPath, markedTo).end
      return markedTo
    },
    since: (mark) =>
      completeLinesFrom(metroLogPath, mark)
        .text.split('\n')
        .filter((line) => line.includes(PROBE_TAG))
        .map((line) => line.slice(line.indexOf(PROBE_TAG) + PROBE_TAG.length))
  }
}
