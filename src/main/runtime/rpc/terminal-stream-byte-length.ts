import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'

export type TerminalStreamByteLengthMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

// UTF-8 encodes a UTF-16 code unit in at most 3 bytes (BMP scalar, or U+FFFD for a lone
// surrogate; a surrogate pair is 4 bytes across 2 units), and never in fewer than 1. So
// `length <= byteLength <= 3 * length` bounds the byte count without touching the string.
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3

// Buffer.byteLength's fixed call cost (~14ns) buys nothing until it replaces enough scan
// iterations (~1.5ns each) to pay for itself; measured crossover is 8-12 code units. Below
// this the native call is a REGRESSION on interactive keystroke-echo chunks, so keep the scan.
export const MIN_NATIVE_BYTE_LENGTH_CODE_UNITS = 16

export function terminalStreamByteLength(data: string): number {
  if (data.length < MIN_NATIVE_BYTE_LENGTH_CODE_UNITS) {
    return measureClipboardTextByteLength(data).byteLength
  }
  return Buffer.byteLength(data, 'utf8')
}

export function terminalStreamByteLengthExceeds(data: string, maxBytes: number): boolean {
  if (data.length === 0 || !Number.isFinite(maxBytes)) {
    return false
  }
  // Sound: UTF-8 is never shorter than UTF-16 code-unit count, so this needs no scan at all.
  if (data.length > maxBytes) {
    return true
  }
  if (data.length < MIN_NATIVE_BYTE_LENGTH_CODE_UNITS) {
    return measureClipboardTextByteLength(data, { stopAfterBytes: maxBytes }).exceededLimit
  }
  return Buffer.byteLength(data, 'utf8') > maxBytes
}

export function measureTerminalStreamByteLength(
  data: string,
  options: { stopAfterBytes?: number } = {}
): TerminalStreamByteLengthMeasurement {
  const stopAfterBytes = options.stopAfterBytes
  if (!Number.isFinite(stopAfterBytes)) {
    return { byteLength: terminalStreamByteLength(data), exceededLimit: false }
  }
  // Why: over the limit the callers keep the scan's TRUNCATED running total, so only take the
  // native count when the upper bound proves it can't trip the limit — otherwise both would run.
  if (
    data.length >= MIN_NATIVE_BYTE_LENGTH_CODE_UNITS &&
    data.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= (stopAfterBytes as number)
  ) {
    return { byteLength: Buffer.byteLength(data, 'utf8'), exceededLimit: false }
  }
  return measureClipboardTextByteLength(data, options)
}
