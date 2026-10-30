// E9 regression: a WSL bridge pane's exit after `wsl --terminate` must not lead Orca to run a command
// in the distro (any `wsl.exe -d <distro> --exec` boots it again) while WSL still lists it as stopping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean; startedAfter?: number }) => Promise<string[]>>(),
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>()
}))
vi.mock('../wsl', () => wslMocks)

import {
  _resetWslBackgroundDistroGateForTests,
  deferUntilWslDistroRunning,
  noteWslDistroMayHaveStopped,
  readConfirmedRunningWslDistros,
  wasWslDistroLastSeenRunningSettled
} from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import {
  PRODUCTION_WSL_BRIDGE_BOOT_IDENTITY_DEPS,
  WslBridgeBootIdentity
} from './daemon-wsl-bridge-boot-identity'
import { classifyWslBridgeExit } from './daemon-wsl-bridge-exit'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
// WSL keeps listing a terminated distro for a moment while it stops.
const STILL_LISTED_MS = 300
let terminatedAt = Number.POSITIVE_INFINITY

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  terminatedAt = Number.POSITIVE_INFINITY
  wslMocks.listWslDistrosAsync.mockResolvedValue(['Ubuntu'])
  wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
    resolveRunningWslDistros(async () => {
      const startedAt = performance.now()
      return startedAt < terminatedAt + STILL_LISTED_MS ? ['Ubuntu'] : []
    }, options)
  )
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('a WSL bridge pane exit after the distro is terminated', () => {
  it('never execs into the distro while it is still being listed as it stops', async () => {
    const readBootId = vi.fn(async () => 'boot-1')
    // Production gate and stop bookkeeping; only the wsl.exe boot-id read is faked.
    const boot = new WslBridgeBootIdentity({
      ...PRODUCTION_WSL_BRIDGE_BOOT_IDENTITY_DEPS,
      readBootId
    })
    boot.noteSpawn('pane-a', 'Ubuntu')
    boot.noteSpawn('pane-b', 'Ubuntu')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())

    await vi.advanceTimersByTimeAsync(60_000)
    terminatedAt = performance.now()
    // Both panes' wsl.exe exit together, as on the awin verify.
    boot.noteExit('Ubuntu')
    boot.noteExit('Ubuntu')
    const exitAt = performance.now()
    const verdicts = Promise.all(
      ['pane-a', 'pane-b'].map((pane) =>
        classifyWslBridgeExit('Ubuntu', exitAt, undefined, () =>
          boot.rebootedSinceSpawn(pane, 'Ubuntu')
        )
      )
    )
    await vi.advanceTimersByTimeAsync(15_000)

    const settled = await verdicts
    // Only the read at spawn, while the distro ran; none after the terminate.
    expect(readBootId).toHaveBeenCalledOnce()
    expect(settled).toEqual(['lost', 'lost'])
  })

  // The pre-boot-id path (build f59bd43): a dying file watcher or hook relay defers its restart
  // until the distro runs, and any confirmed list used to drain it, one probed mid-stop included.
  it('runs no deferred work off a list probed while the distro was still stopping', async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    terminatedAt = performance.now()
    noteWslDistroMayHaveStopped('Ubuntu')
    const restarts = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'fs-watch:root-a', restarts)
    deferUntilWslDistroRunning('Ubuntu', 'fs-watch:root-b', restarts)

    // Some other read, e.g. a bridge exit's verdict, probes while WSL still lists the distro.
    await expect(readConfirmedRunningWslDistros()).resolves.toEqual({
      status: 'confirmed',
      distros: ['Ubuntu']
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await readConfirmedRunningWslDistros()

    expect(restarts).not.toHaveBeenCalled()
  })

  it('still runs deferred work once a settled list shows the distro running again', async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    noteWslDistroMayHaveStopped('Ubuntu')
    const restarts = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'fs-watch:root-a', restarts)
    await vi.advanceTimersByTimeAsync(1_000)

    await readConfirmedRunningWslDistros()

    expect(restarts).toHaveBeenCalledOnce()
  })

  // Review of #35143: Sleep and quit reads skip the probe for a pane they hold live.
  it('does not let a list taken before the stop vouch for a live pane', async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    await readConfirmedRunningWslDistros()
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu')).toBe(true)

    terminatedAt = performance.now()
    noteWslDistroMayHaveStopped('Ubuntu')
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu')).toBe(false)

    // A probe while it still stops names it, yet is inside the settle window.
    await readConfirmedRunningWslDistros()
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu')).toBe(false)
  })

  it('lists once more past the settle when a mid-stop list skipped deferred work', async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    noteWslDistroMayHaveStopped('Ubuntu')
    const restarts = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'fs-watch:root-a', restarts)
    // A false stop signal: the distro never went away, so a settled list names it.
    await readConfirmedRunningWslDistros()
    expect(restarts).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(restarts).toHaveBeenCalledOnce()
  })
})
