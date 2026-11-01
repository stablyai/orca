import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'

export type TerminalStreamByteLengthMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

// UTF-8 uses 1–3 bytes per UTF-16 unit, including replacement characters; pairs use 4 bytes for 2 units. Bound bytes without scanning.
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3

// Native counting costs ~14ns versus ~1.5ns per scan unit; the 8–12-unit crossover makes scanning faster for small keystroke echoes.
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
  // UTF-8 byte count cannot be below UTF-16 unit count; no scan needed.
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
