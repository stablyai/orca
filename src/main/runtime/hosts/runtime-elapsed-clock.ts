import type { ElapsedClockBounds } from '../../../shared/terminal/input/terminal-chat-prompt-budget'

let previous: { monotonic: bigint; wall: bigint; elapsed: bigint } | undefined

// Grants and checks share this process/module epoch; wall corrections can expire them early or hide suspend time.
export function readRuntimeElapsedClock(): ElapsedClockBounds | null {
  try {
    const monotonic = process.hrtime.bigint()
    const wallMs = Date.now()
    if (monotonic < 0n || !Number.isSafeInteger(wallMs)) {
      return null
    }
    const wall = BigInt(wallMs)
    const monotonicDelta = previous ? monotonic - previous.monotonic : 0n
    const wallDelta = previous ? (wall - previous.wall) * 1_000_000n : 0n
    const delta = monotonicDelta > wallDelta ? monotonicDelta : wallDelta
    const elapsed = (previous?.elapsed ?? 0n) + (delta > 0n ? delta : 0n)
    const lower = Number(elapsed / 1_000_000n)
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(lower + 1)) {
      return null
    }
    previous = { monotonic, wall, elapsed }
    return { lower, upper: lower + 1 }
  } catch {
    return null
  }
}
