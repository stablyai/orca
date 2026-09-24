import type { MinidumpSource } from './minidump-stream-reader'

const CHROMIUM_LOG_MARKERS = [
  Buffer.from(':FATAL:', 'ascii'),
  Buffer.from(':CHECK:', 'ascii'),
  Buffer.from(':DFATAL:', 'ascii'),
  Buffer.from(':ERROR:', 'ascii')
]
const MAX_LOG_PREFIX_BYTES = 96
const MAX_CHECK_LOG_BYTES = 4_000
const MAX_MARKERS_PER_SEVERITY = 256
const CHECK_LOG_PATTERN =
  /^\[(?:\d+:){1,2}\d{4}\/\d{6}\.\d{3,6}:(FATAL|CHECK|DFATAL|ERROR)(?::[^:\]\r\n]{1,80})*:([^:\]\r\n]{1,512}?)(?:\((\d+)\)|:(\d+))\]\s*(.+)$/
const ERROR_CHECK_PATTERN = /\b(?:Check failed:|D?CHECK failed:|Intentionally causing D?CHECK\b)/i

export type LocatedCheckMessage = {
  readonly message: string
  readonly file?: string
  readonly line?: number
}

function isPrintableLogByte(value: number): boolean {
  return value === 0x09 || (value >= 0x20 && value <= 0x7e)
}

/**
 * `lastIndexOf(byte, from)` restricted to `within` bytes before `from`. An
 * unbounded search scans the whole dump backward on a miss only for the result
 * to be thrown away by the same prefix limit; zero-filled regions are normal in
 * a minidump, so that miss is the common case, not the adversarial one.
 */
function lastIndexOfWithin(dump: Buffer, byte: number, from: number, within: number): number {
  const floor = Math.max(0, from - within)
  for (let at = from; at >= floor; at -= 1) {
    if (dump[at] === byte) {
      return at
    }
  }
  return -1
}

/** Electron 43 omits LOG_FATAL but keeps Chromium's formatted log line in memory. */
export async function findEmbeddedCheckMessage(
  source: MinidumpSource
): Promise<LocatedCheckMessage | undefined> {
  const blockBytes = 1024 * 1024
  const states: { marker: Buffer; inspected: number; found?: LocatedCheckMessage }[] =
    CHROMIUM_LOG_MARKERS.map((marker) => ({ marker, inspected: 0 }))
  let from = 0
  while (from < source.byteLength) {
    const startAt = Math.max(0, from - MAX_LOG_PREFIX_BYTES)
    const bytes = await source.read(
      startAt,
      Math.min(from - startAt + blockBytes + MAX_CHECK_LOG_BYTES, source.byteLength - startAt)
    )
    if (bytes.length === 0) {
      break
    }
    const scanEnd = Math.min(bytes.length, from - startAt + blockBytes)
    for (const state of states) {
      let next = from - startAt
      while (!state.found && next < scanEnd && state.inspected < MAX_MARKERS_PER_SEVERITY) {
        const markerAt = bytes.indexOf(state.marker, next)
        if (markerAt === -1 || markerAt >= scanEnd) {
          break
        }
        state.inspected++
        next = markerAt + state.marker.length
        state.found = readCheckAt(bytes, markerAt, next)
      }
    }
    // A lower severity cannot win until each earlier severity is exhausted.
    for (const state of states) {
      if (state.found) {
        return state.found
      }
      if (state.inspected < MAX_MARKERS_PER_SEVERITY) {
        break
      }
    }
    from = startAt + scanEnd
  }
  return states.find((state) => state.found)?.found
}

function readCheckAt(
  bytes: Buffer,
  markerAt: number,
  afterMarker: number
): LocatedCheckMessage | undefined {
  const start = lastIndexOfWithin(bytes, 0x5b, markerAt, MAX_LOG_PREFIX_BYTES)
  if (start === -1) {
    return undefined
  }
  let end = afterMarker
  const limit = Math.min(bytes.length, start + MAX_CHECK_LOG_BYTES)
  while (end < limit && isPrintableLogByte(bytes[end])) {
    end++
  }
  const candidate = bytes.subarray(start, end).toString('utf8')
  const match = CHECK_LOG_PATTERN.exec(candidate)
  if (!match || (match[1] === 'ERROR' && !ERROR_CHECK_PATTERN.test(match[5]))) {
    return undefined
  }
  const line = Number.parseInt(match[3] ?? match[4], 10)
  const separator = Math.max(match[2].lastIndexOf('/'), match[2].lastIndexOf('\\'))
  return {
    message: candidate,
    file: match[2].slice(separator + 1),
    line: Number.isFinite(line) ? line : undefined
  }
}
