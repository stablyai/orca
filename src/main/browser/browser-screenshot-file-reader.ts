import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  BROWSER_SCREENSHOT_MAX_ENCODED_BYTES,
  BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
} from './browser-screenshot-limits'

const MIN_GROWTH_BYTES = 64 * 1024

function throwIfOverLimit(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new Error(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
  }
}

export function readBrowserScreenshotFile(
  path: string,
  maxBytes = BROWSER_SCREENSHOT_MAX_ENCODED_BYTES
): Buffer {
  const descriptor = openSync(path, 'r')
  try {
    const initialSize = fstatSync(descriptor).size
    throwIfOverLimit(initialSize, maxBytes)
    let bytes = Buffer.allocUnsafe(initialSize)
    let offset = 0

    while (true) {
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, null)
        if (read === 0) {
          return bytes.subarray(0, offset)
        }
        offset += read
      }

      const probe = Buffer.allocUnsafe(1)
      if (readSync(descriptor, probe, 0, 1, null) === 0) {
        return bytes.subarray(0, offset)
      }
      throwIfOverLimit(offset + 1, maxBytes)

      const nextCapacity = Math.min(
        maxBytes,
        Math.max(MIN_GROWTH_BYTES, bytes.length * 2, offset + 1)
      )
      const expanded = Buffer.allocUnsafe(nextCapacity)
      bytes.copy(expanded, 0, 0, offset)
      expanded[offset] = probe[0]!
      bytes = expanded
      offset += 1
    }
  } finally {
    closeSync(descriptor)
  }
}
