import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { startRegionalRehomeWorker } from './regional-rehome-worker.js'
import { jitteredSweepIntervalMs, SWEEP_JITTER_FRACTION } from './relay-sweep-schedule.js'

describe('sweep schedule jitter', () => {
  it('spreads instances across a bounded window above the base period', () => {
    expect(jitteredSweepIntervalMs(30_000, () => 0)).toBe(30_000)
    expect(jitteredSweepIntervalMs(30_000, () => 0.5)).toBe(33_000)
    // Math.random() never returns 1, so the open bound is the real ceiling.
    expect(jitteredSweepIntervalMs(30_000, () => 0.999)).toBeLessThan(36_000)
  })

  // Why: a shorter period would raise the very lock traffic the offset spreads.
  it('never schedules a sweep sooner than its base period', () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(jitteredSweepIntervalMs(1_000, () => random)).toBeGreaterThanOrEqual(1_000)
    }
    expect(SWEEP_JITTER_FRACTION).toBeGreaterThan(0)
  })

  it('jitters the regional rehome dispatch tick, which every director runs each second', () => {
    const timers: number[] = []
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((_handler: unknown, delayMs?: number) => {
        timers.push(delayMs ?? 0)
        return { unref: () => undefined, [Symbol.dispose]: () => undefined } as never
      }) as never)

    try {
      startRegionalRehomeWorker(
        {
          role: 'director',
          rehomeAudience: 'https://rehome.example.test',
          rehomeDirectorServiceAccount: 'rehome@example.test'
        } as never,
        { claimRegionalRehome: async () => null } as never,
        { random: () => 0.5, safetySnapshot: () => ({}) as never }
      )
    } finally {
      setIntervalSpy.mockRestore()
    }

    expect(timers).toEqual([1_100])
  })

  // Why: index.ts boots a server on import, so its wiring can only be read.
  it('jitters the director assignment cleanup tick', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const cleanup = /runAssignmentCleanup\(assignments\)\s*\},\s*([^\n]*?)\)\n/.exec(source)

    expect(cleanup?.[1]).toBe('jitteredSweepIntervalMs(30_000)')
  })
})
