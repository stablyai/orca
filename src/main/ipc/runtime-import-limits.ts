// Streaming bounds memory; these caps bound unattended transfers until the UI offers progress and cancellation.
export const REMOTE_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const REMOTE_IMPORT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024

/** Rounds up, so a size over a ceiling never renders as the ceiling itself. */
export function formatByteCeiling(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = Math.ceil(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`
}
