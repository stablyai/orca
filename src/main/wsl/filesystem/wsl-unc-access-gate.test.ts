import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean; startedAfter?: number }) => Promise<string[]>>(),
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>()
}))
vi.mock('../discovery/distro-catalog', () => wslMocks)

import {
  assertWslUncPathRunning,
  guardWslUncPathAccess,
  runAsWslUserAct,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from './wsl-unc-access-gate'
import {
  _resetWslBackgroundDistroGateForTests,
  deferUntilWslDistroRunning,
  noteWslDistroMayHaveStopped,
  noteWslDistrosRunning
} from '../discovery/wsl-background-distro-gate'
import '../orcad/wsl-orcad-liveness-evidence'
import { isWslUserActFor } from '../discovery/wsl-user-act-scope'
import '../../../shared/wsl-distro-not-running-refusal'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../discovery/wsl-running-distro-cache'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let running: string[] = ['Ubuntu']
const probe = vi.fn(async () => running)

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  running = ['Ubuntu']
  probe.mockReset().mockImplementation(async () => running)
  wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
    resolveRunningWslDistros(probe, options)
  )
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('guardWslUncPathAccess', () => {
  it('refuses a background touch of a stopped distro without touching the path', async () => {
    running = []
    const access = vi.fn(async () => 'read')
    await expect(guardWslUncPathAccess(UNC, access)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(access).not.toHaveBeenCalled()
  })

  it('does not trust a running read that started before the distro may have stopped', async () => {
    await guardWslUncPathAccess(UNC, async () => 'read')
    // The terminate: the read above still says running, but a link into the distro just died.
    running = []
    noteWslDistroMayHaveStopped('ubuntu')
    const access = vi.fn(async () => 'read')
    await expect(guardWslUncPathAccess(UNC, access)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(access).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("says WSL didn't answer, not that the distro stopped, and never touches the path", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    probe.mockRejectedValue(new Error('wsl.exe timed out'))
    const access = vi.fn(async () => 'read')
    const refusal = guardWslUncPathAccess(UNC, access)
    await expect(refusal).rejects.toBeInstanceOf(WslDistroUnverifiableError)
    await expect(refusal).rejects.toThrow("didn't answer")
    // Inside the same failure window the backoff holds: no spawn per background read.
    await expect(guardWslUncPathAccess(UNC, access)).rejects.toBeInstanceOf(
      WslDistroUnverifiableError
    )
    expect(probe).toHaveBeenCalledTimes(2)
    expect(access).not.toHaveBeenCalled()
  })

  it('a user act touches without asking and, on success, resumes work waiting for the distro', async () => {
    running = []
    const resumed = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'test', resumed)
    await expect(guardWslUncPathAccess(UNC, async () => 'read', { wake: true })).resolves.toBe(
      'read'
    )
    expect(probe).not.toHaveBeenCalled()
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('a failed user act resumes nothing', async () => {
    const resumed = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'test', resumed)
    await expect(
      guardWslUncPathAccess(
        UNC,
        async () => {
          throw new Error('EIO')
        },
        { wake: true }
      )
    ).rejects.toThrow('EIO')
    expect(resumed).not.toHaveBeenCalled()
  })
})

describe('runAsWslUserAct', () => {
  it('lets gated work inside a user act start its own distro, and no other', async () => {
    running = []
    await runAsWslUserAct('ubuntu', async () => {
      await expect(assertWslUncPathRunning(UNC)).resolves.toBeUndefined()
      await expect(
        assertWslUncPathRunning('\\\\wsl.localhost\\Debian\\repo')
      ).rejects.toBeInstanceOf(WslDistroStoppedError)
    })
    await expect(assertWslUncPathRunning(UNC)).rejects.toBeInstanceOf(WslDistroStoppedError)
  })

  it('after a user act starts the distro, background reads no longer trust the old stopped read', async () => {
    running = []
    await expect(guardWslUncPathAccess(UNC, async () => 'read')).rejects.toBeInstanceOf(
      WslDistroStoppedError
    )
    // The wake read's 9P touch started the distro.
    running = ['Ubuntu']
    await guardWslUncPathAccess(UNC, async () => 'read', { wake: true })
    await expect(guardWslUncPathAccess(UNC, async () => 'read')).resolves.toBe('read')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('user-act scope does not leak', () => {
  it('deferred work drained inside a user act runs outside it', async () => {
    const inherited: boolean[] = []
    deferUntilWslDistroRunning('Ubuntu', 'leak', () => {
      inherited.push(isWslUserActFor('Ubuntu'))
    })
    await runAsWslUserAct('Ubuntu', async () => noteWslDistrosRunning(['Ubuntu']))
    expect(inherited).toEqual([false])
  })

  it('work a probe started inside a user act releases runs outside it', async () => {
    running = ['Ubuntu']
    const inherited: boolean[] = []
    deferUntilWslDistroRunning('Ubuntu', 'leak', () => {
      inherited.push(isWslUserActFor('Ubuntu'))
    })
    await runAsWslUserAct('Ubuntu', () => resolveRunningWslDistros(probe))
    expect(inherited).toEqual([false])
  })
})
