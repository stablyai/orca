import { describe, expect, it, vi } from 'vitest'

vi.mock('../wsl', () => ({
  listRunningWslDistrosAsync: vi.fn(),
  listWslDistrosAsync: vi.fn()
}))
vi.mock('./wsl-runner', () => ({ runWslProcess: vi.fn() }))

import {
  ACTIVITY_CHECK_DELAY_MS,
  ACTIVITY_CHECK_INTERVAL_MS,
  REPAIR_FAILURE_BACKOFF_MS,
  STOP_CHECK_FLOOR_MS,
  WslInteropHealthMonitor,
  type WslInteropHealthDeps
} from './wsl-interop-health'
import { WSL_INTEROP_PROBE_SCRIPT, WSL_INTEROP_REPAIR_SCRIPT } from './wsl-interop-registration'

const PRESENT = 'orca-wsl-interop:present\n'
const MISSING = 'orca-wsl-interop:missing\norca-wsl-interop:conf\n'
const MISSING_DISABLED = `${MISSING}[interop]\nenabled=false\n`

function harness(overrides: Partial<WslInteropHealthDeps> = {}) {
  let now = 1_000_000
  const timers: { fn: () => void; delayMs: number }[] = []
  let stopListener: ((stopped: string[], running: string[]) => void) | null = null
  const deps: WslInteropHealthDeps = {
    platform: () => 'win32',
    listRunningDistros: vi.fn(async () => ['Ubuntu']),
    resolveDefaultDistro: vi.fn(async () => 'Ubuntu'),
    runScript: vi.fn(async () => ({ code: 0, stdout: PRESENT })),
    subscribeStops: (listener) => {
      stopListener = listener
      return () => {
        stopListener = null
      }
    },
    now: () => now,
    schedule: (fn, delayMs) => {
      timers.push({ fn, delayMs })
    },
    log: vi.fn(),
    ...overrides
  }
  const monitor = new WslInteropHealthMonitor(deps)
  return {
    deps,
    monitor,
    timers,
    advance: (ms: number) => {
      now += ms
    },
    runTimers: () => {
      for (const timer of timers.splice(0)) {
        timer.fn()
      }
    },
    emitStop: (stopped: string[], running: string[]) => stopListener?.(stopped, running)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('WslInteropHealthMonitor.check', () => {
  it('reports intact without repairing', async () => {
    const h = harness()
    await expect(h.monitor.check('Ubuntu', { confirmRunning: true })).resolves.toBe('intact')
    expect(h.deps.runScript).toHaveBeenCalledTimes(1)
    expect(h.deps.runScript).toHaveBeenCalledWith('Ubuntu', WSL_INTEROP_PROBE_SCRIPT)
  })

  it('repairs as root when the entry is missing', async () => {
    const runScript = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: MISSING })
      .mockResolvedValueOnce({ code: 0, stdout: 'orca-wsl-interop:repaired\n' })
    const h = harness({ runScript })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: true })).resolves.toBe('repaired')
    expect(runScript).toHaveBeenLastCalledWith('Ubuntu', WSL_INTEROP_REPAIR_SCRIPT, 'root')
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('wsl --update'))
  })

  it('respects interop disabled in wsl.conf', async () => {
    const runScript = vi.fn(async () => ({ code: 0, stdout: MISSING_DISABLED }))
    const h = harness({ runScript })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: true })).resolves.toBe(
      'interop-disabled'
    )
    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('never runs inside a distro that is not running', async () => {
    const h = harness({ listRunningDistros: vi.fn(async () => ['Debian']) })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: true })).resolves.toBe('not-running')
    expect(h.deps.runScript).not.toHaveBeenCalled()
  })

  it('treats an unconfirmed running list as not running', async () => {
    const h = harness({
      listRunningDistros: vi.fn(async () => {
        throw new Error('unavailable')
      })
    })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: true })).resolves.toBe('not-running')
    expect(h.deps.runScript).not.toHaveBeenCalled()
  })

  it('is single-flight per distro', async () => {
    let release: (value: { code: number; stdout: string }) => void = () => undefined
    const runScript = vi.fn(
      () =>
        new Promise<{ code: number; stdout: string }>((resolve) => {
          release = resolve
        })
    )
    const h = harness({ runScript })
    const first = h.monitor.check('Ubuntu', { confirmRunning: false })
    const second = h.monitor.check('ubuntu', { confirmRunning: false })
    expect(second).toBe(first)
    await flush()
    release({ code: 0, stdout: PRESENT })
    await expect(first).resolves.toBe('intact')
    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('backs off after a failed repair', async () => {
    const runScript = vi.fn(async (_distro: string, script: string) =>
      script === WSL_INTEROP_PROBE_SCRIPT ? { code: 0, stdout: MISSING } : { code: 1, stdout: '' }
    )
    const h = harness({ runScript })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: false })).resolves.toBe(
      'repair-failed'
    )
    await expect(h.monitor.check('Ubuntu', { confirmRunning: false })).resolves.toBe(
      'repair-failed'
    )
    expect(runScript).toHaveBeenCalledTimes(3)
    h.advance(REPAIR_FAILURE_BACKOFF_MS)
    await h.monitor.check('Ubuntu', { confirmRunning: false })
    expect(runScript).toHaveBeenCalledTimes(5)
  })

  it('reports unknown when the probe throws', async () => {
    const h = harness({
      runScript: vi.fn(async () => {
        throw new Error('timeout')
      })
    })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: false })).resolves.toBe('unknown')
  })
})

describe('WslInteropHealthMonitor triggers', () => {
  it('does nothing off Windows', async () => {
    const h = harness({ platform: () => 'darwin' })
    h.monitor.noteActivity('Ubuntu')
    await flush()
    expect(h.timers).toHaveLength(0)
  })

  it('checks once after a delay and throttles repeated activity', async () => {
    const h = harness()
    h.monitor.noteActivity(null)
    h.monitor.noteActivity('Ubuntu')
    await flush()
    expect(h.timers).toEqual([{ fn: expect.any(Function), delayMs: ACTIVITY_CHECK_DELAY_MS }])
    expect(h.deps.runScript).not.toHaveBeenCalled()
    h.runTimers()
    await flush()
    expect(h.deps.listRunningDistros).toHaveBeenCalledTimes(1)
    expect(h.deps.runScript).toHaveBeenCalledTimes(1)

    h.monitor.noteActivity('Ubuntu')
    await flush()
    expect(h.timers).toHaveLength(0)
    h.advance(ACTIVITY_CHECK_INTERVAL_MS)
    h.monitor.noteActivity('Ubuntu')
    await flush()
    expect(h.timers).toHaveLength(1)
  })

  it('re-checks used distros that are still running when another distro stops', async () => {
    const h = harness()
    h.monitor.noteActivity('Ubuntu')
    await flush()
    h.runTimers()
    await flush()
    expect(h.deps.runScript).toHaveBeenCalledTimes(1)
    h.advance(10_000)
    h.emitStop(['docker-desktop'], ['Ubuntu'])
    await flush()
    expect(h.deps.runScript).toHaveBeenCalledTimes(2)
    // The confirmed list that reported the stop already proves Ubuntu is up.
    expect(h.deps.listRunningDistros).toHaveBeenCalledTimes(1)
    h.advance(10_000)
    h.emitStop(['Ubuntu'], [])
    await flush()
    expect(h.deps.runScript).toHaveBeenCalledTimes(2)
  })

  it('bounds probes under bursts of activity and stop events', async () => {
    const h = harness()
    for (let i = 0; i < 50; i++) {
      h.monitor.noteActivity('Ubuntu')
    }
    await flush()
    h.runTimers()
    await flush()
    for (let elapsed = 0; elapsed < ACTIVITY_CHECK_INTERVAL_MS - 1_000; elapsed += 1_000) {
      h.advance(1_000)
      h.monitor.noteActivity('Ubuntu')
      await flush()
      h.runTimers()
      await flush()
    }
    expect(h.deps.runScript).toHaveBeenCalledTimes(1)

    // Stop-triggered checks are rate-floored and skip distros the list no longer shows.
    h.emitStop(['docker-desktop'], ['Ubuntu'])
    await flush()
    expect(h.deps.runScript).toHaveBeenCalledTimes(2)
    h.advance(STOP_CHECK_FLOOR_MS - 1)
    h.emitStop(['Debian'], ['Ubuntu'])
    h.emitStop(['Debian'], ['Ubuntu'])
    await flush()
    expect(h.deps.runScript).toHaveBeenCalledTimes(2)
    h.advance(1)
    h.emitStop(['Ubuntu'], [])
    await flush()
    expect(h.deps.runScript).toHaveBeenCalledTimes(2)
  })

  it('treats an entry restored between probe and repair as intact', async () => {
    const h = harness({
      runScript: vi.fn(async (_distro: string, script: string) => ({
        code: 0,
        stdout: script === WSL_INTEROP_PROBE_SCRIPT ? MISSING : PRESENT
      }))
    })
    await expect(h.monitor.check('Ubuntu', { confirmRunning: false })).resolves.toBe('intact')
    expect(h.deps.log).not.toHaveBeenCalled()
  })
})
