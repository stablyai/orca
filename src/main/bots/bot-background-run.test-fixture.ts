import type { vi } from 'vitest'
import type { BackgroundRunPower } from './bot-background-run'

/** A host's power for a runner under test: awake, settled and in full wake until told otherwise.
 *  `sleep` takes time off the awake clock (the caller moves the wall clock it passed in);
 *  `suspend` is a suspend the system reported, however short. */
export function testRunPower(wall: () => number = () => Date.now()) {
  let sleptMs = 0
  let settled = true
  let fullWake = true
  let suspends = 0
  let read: (() => Promise<boolean>) | undefined
  const holds = { taken: 0, released: 0 }
  const power: BackgroundRunPower = {
    settled: () => settled,
    checkFullWake: async () => settled && (await (read?.() ?? fullWake)),
    suspends: () => suspends,
    epoch: () => suspends,
    awakeNow: () => wall() - sleptMs,
    wallNow: wall,
    holdAwake: () => {
      holds.taken += 1
      let released = false
      return () => {
        if (!released) {
          released = true
          holds.released += 1
        }
      }
    }
  }
  return {
    power,
    holds,
    setSettled: (value: boolean) => (settled = value),
    /** False: a dark wake, however long the host has been up. */
    setFullWake: (value: boolean) => (fullWake = value),
    /** Replaces the system-state read, e.g. to hold one open. */
    setFullWakeRead: (next: (() => Promise<boolean>) | undefined) => (read = next),
    /** The host slept `ms` of the wall time that passes. */
    sleep: (ms: number) => (sleptMs += ms),
    suspend: () => (suspends += 1)
  }
}

/** Fake timers that also move Date and performance, as the awake clock reads them. */
export const WITH_CLOCKS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: [
    'Date',
    'performance',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate'
  ]
}
