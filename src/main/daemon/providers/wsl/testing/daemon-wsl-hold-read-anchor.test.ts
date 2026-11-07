import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../../../../wsl/discovery/distro-catalog'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistroMayHaveStopped
} from '../../../../wsl/discovery/wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../../../../wsl/discovery/wsl-running-distro-cache'
import { parseWslDistroHold } from '../../../../../shared/wsl-distro-stopped-hold'
import {
  holdPassiveRestoreOfStoppedWslDistro,
  wslHoldReadAnchor
} from '../daemon-wsl-passive-restore-hold'

const running = vi.hoisted(() => {
  const value: { distros: string[] } = { distros: ['Ubuntu'] }
  return value
})
const probe = vi.hoisted(() => vi.fn(async () => [...running.distros]))
vi.mock('../../../../wsl/discovery/distro-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  listRunningWslDistrosAsync: (options: Parameters<typeof resolveRunningWslDistros>[1]) =>
    resolveRunningWslDistros(probe, options)
}))

const HELD = { wslBackgroundStart: true as const, isNewSession: true }
// The startup-target hold and the provider hold of one spawn share that spawn's anchor.
const hold = (anchor?: number) =>
  holdPassiveRestoreOfStoppedWslDistro(
    anchor === undefined ? HELD : { ...HELD, wslHoldReadAnchor: anchor },
    'Ubuntu'
  )
const heldState = (error: unknown) =>
  error instanceof Error ? parseWslDistroHold(error.message)?.state : undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout'] })
  running.distros = ['Ubuntu']
  probe.mockClear()
})

afterEach(() => {
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.useRealTimers()
})

describe('a held WSL spawn reuses only its own running read (E9)', () => {
  it('reads fresh, and holds, after a stop noted between the two holds', async () => {
    const anchor = wslHoldReadAnchor()
    await hold(anchor)
    noteWslDistroMayHaveStopped('Ubuntu')
    running.distros = []
    // The stop's settle window has to pass before a read counts.
    const provider = hold(anchor).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(heldState(await provider)).toBe('stopped')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
