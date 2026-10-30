import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setActiveSink } from '../../observability/tracer'
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
