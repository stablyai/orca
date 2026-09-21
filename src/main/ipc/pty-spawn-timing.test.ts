import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setActiveSink } from '../observability/tracer'
import { createPtySpawnTiming } from './pty-spawn-timing'

const records: unknown[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance'] })
  records.length = 0
  setActiveSink({
    push: (r) => {
      records.push(r)
    },
    flush() {},
    close() {}
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  setActiveSink(null)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('keeps disabled spawn timing silent', () => {
  vi.stubEnv('ORCA_PTY_SPAWN_TIMING', '0')
  const timing = createPtySpawnTiming()
  timing.mark('provider_spawn')
  timing.log('pty-1')
  expect(records).toEqual([])
  expect(console.log).not.toHaveBeenCalled()
})

it('writes numeric monotonic phase durations through the existing local trace sink', () => {
  vi.stubEnv('ORCA_PTY_SPAWN_TIMING', '1')
  const timing = createPtySpawnTiming()
  vi.advanceTimersByTime(25)
  timing.mark('preflight')
  vi.advanceTimersByTime(80)
  timing.mark('provider_spawn')
  timing.log('pty-1', { daemon: true, reattach: false })
  expect(records).toEqual([
    expect.objectContaining({
      name: 'pty.spawn.timing',
      attributes: expect.objectContaining({
        ptyId: 'pty-1',
        totalMs: 105,
        phaseDurations: { preflight: 25, provider_spawn: 80 },
        daemon: true,
        reattach: false
      })
    })
  ])
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('total=105ms preflight=25ms provider_spawn=80ms')
  )
})

it('does not fail a successful spawn when the diagnostic sink throws', () => {
  vi.stubEnv('ORCA_PTY_SPAWN_TIMING', '1')
  setActiveSink({
    push() {
      throw new Error('disk unavailable')
    },
    flush() {},
    close() {}
  })
  expect(() => createPtySpawnTiming().log('pty-1')).not.toThrow()
})
