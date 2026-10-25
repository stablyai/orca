import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EVENT_LOOP_DELAY_REPORT_FILE,
  isEventLoopDelayProbeEnabled,
  startEventLoopDelayProbe
} from './event-loop-delay-probe'

describe('event-loop delay probe', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.useRealTimers()
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })
  const userData = (): string => {
    const dir = mkdtempSync(join(os.tmpdir(), 'event-loop-delay-'))
    dirs.push(dir)
    return dir
  }

  it('runs only for e2e runs or the explicit opt-in', () => {
    expect(isEventLoopDelayProbeEnabled({})).toBe(false)
    expect(isEventLoopDelayProbeEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(isEventLoopDelayProbeEnabled({ ORCA_E2E_USER_DATA_DIR: '/tmp/x' })).toBe(true)
    expect(isEventLoopDelayProbeEnabled({ ORCA_EVENT_LOOP_DELAY_PROBE: '1' })).toBe(true)
  })

  it('writes nothing when disabled', () => {
    vi.useFakeTimers()
    const dir = userData()
    startEventLoopDelayProbe('main', dir, {})
    vi.advanceTimersByTime(5_000)
    expect(existsSync(join(dir, EVENT_LOOP_DELAY_REPORT_FILE))).toBe(false)
  })

  it('appends one window per second with the process and an epoch end time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    const dir = userData()
    const started = Date.now()
    startEventLoopDelayProbe('orcad', dir, { ORCA_EVENT_LOOP_DELAY_PROBE: '1' })
    vi.advanceTimersByTime(2_000)
    const file = join(dir, EVENT_LOOP_DELAY_REPORT_FILE)
    await vi.waitFor(() => expect(readFileSync(file, 'utf8').split('\n')).toHaveLength(3))
    // Appends are async, so lines may land out of order; readers match windows by `t`.
    const [first] = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .toSorted((a, b) => a.t - b.t)
    expect(first).toMatchObject({ process: 'orcad', pid: process.pid, windowMs: 1_000 })
    expect(first.t).toBe(started + 1_000)
    expect(first.max).toBeGreaterThanOrEqual(0)
  })
})
