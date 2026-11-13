import { closeSync, openSync, readSync } from 'node:fs'
import type { ElapsedClockBounds } from '../../../shared/terminal/input/terminal-chat-prompt-budget'

/** A fixed suspend-inclusive clock; changing origins would invalidate already granted expiries. */
export function readRuntimeElapsedClock(): ElapsedClockBounds | null {
  try {
    if (process.platform !== 'linux') {
      const lower = Number(process.hrtime.bigint() / 1_000_000n)
      return Number.isSafeInteger(lower) && lower >= 0 && Number.isSafeInteger(lower + 1)
        ? { lower, upper: lower + 1 }
        : null
    }
    const fd = openSync('/proc/uptime', 'r')
    const bytes = Buffer.allocUnsafe(128)
    let count: number
    try {
      count = readSync(fd, bytes, 0, bytes.length, 0)
    } finally {
      closeSync(fd)
    }
    const match = /^(\d+)\.(\d{2})\s/.exec(bytes.toString('ascii', 0, count))
    if (!match) {
      return null
    }
    const lower = Number(match[1]) * 1000 + Number(match[2]) * 10
    return Number.isSafeInteger(lower) && lower >= 0 && Number.isSafeInteger(lower + 10)
      ? { lower, upper: lower + 10 }
      : null
  } catch {
    return null
  }
}
