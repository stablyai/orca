import { vi } from 'vitest'
import type * as AsyncRead from '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-reads'

// Every async rollout read in the rollout read tests goes through this gate: it counts reads in
// flight per file and can hold a result back after the bytes were read, which is how a slow open
// or a late read looks. A test file installs it with `vi.mock(..., gatedRolloutReads)`.
export const reads: {
  gate?: (filePath: string) => Promise<void>
  inFlight: Map<string, number>
  maxInFlight: number
  io: Set<Promise<unknown>>
} = { inFlight: new Map(), maxInFlight: 0, io: new Set() }

export async function gatedRolloutReads(
  importOriginal: () => Promise<typeof AsyncRead>
): Promise<typeof AsyncRead> {
  const actual = await importOriginal()
  const gated =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>, pathOf: (...args: A) => string) =>
    async (...args: A): Promise<R> => {
      const filePath = pathOf(...args)
      const count = (reads.inFlight.get(filePath) ?? 0) + 1
      reads.inFlight.set(filePath, count)
      reads.maxInFlight = Math.max(reads.maxInFlight, count)
      try {
        const io = read(...args)
        reads.io.add(io)
        const result = await io.finally(() => reads.io.delete(io))
        await reads.gate?.(filePath)
        return result
      } finally {
        reads.inFlight.set(filePath, (reads.inFlight.get(filePath) ?? 1) - 1)
      }
    }
  return {
    ...actual,
    readJsonlCursorBytes: gated(actual.readJsonlCursorBytes, (cursor) => cursor.filePath ?? ''),
    readJsonlFirstRecordAsync: gated(actual.readJsonlFirstRecordAsync, (path) => path)
  }
}

export function resetRolloutReadGate(): void {
  reads.gate = undefined
  reads.inFlight.clear()
  reads.maxInFlight = 0
}

/** Let real file I/O finish and fake time run, so reads land and tails tick. */
export async function settle(ms = 12_000): Promise<void> {
  const drainIo = async (): Promise<void> => {
    while (reads.io.size > 0) {
      await Promise.allSettled(reads.io)
      await vi.advanceTimersByTimeAsync(0)
    }
  }
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await drainIo()
    await vi.advanceTimersByTimeAsync(250)
  }
  await drainIo()
}

/** Hold every read (or only `onlyPath`'s) after it took its bytes; `captured` is the first such read. */
export function holdReads(onlyPath?: string): { captured: Promise<void>; releaseAll: () => void } {
  const releases: (() => void)[] = []
  let captured: () => void = () => {}
  const capturedPromise = new Promise<void>((resolve) => (captured = resolve))
  reads.gate = (filePath) => {
    if (onlyPath !== undefined && filePath !== onlyPath) {
      return Promise.resolve()
    }
    captured()
    return new Promise((resolve) => releases.push(resolve))
  }
  return {
    captured: capturedPromise,
    releaseAll: () => {
      reads.gate = undefined
      for (const release of releases.splice(0)) {
        release()
      }
    }
  }
}
