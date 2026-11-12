import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean }) => Promise<string[]>>(),
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>()
}))
vi.mock('./distro-catalog', () => wslMocks)

import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistroMayHaveStopped,
  noteWslDistroWoken,
  onWslDistroGateNote
} from './wsl-background-distro-gate'
import { isWslUserActFor, runAsWslUserAct } from './wsl-user-act-scope'
import { _resetRunningWslDistroCacheForTests } from './wsl-running-distro-cache'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  wslMocks.listRunningWslDistrosAsync.mockResolvedValue(['Ubuntu'])
  wslMocks.listWslDistrosAsync.mockResolvedValue(['Debian', 'Ubuntu'])
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('gate note listeners (E9)', () => {
  it("never run inside the user act whose wake or stop they hear, so their work can't borrow it", async () => {
    const insideAct: boolean[] = []
    onWslDistroGateNote(() => insideAct.push(isWslUserActFor('Ubuntu')))

    await runAsWslUserAct(
      'Ubuntu',
      async () => {
        // The act's own work holds the allowance.
        expect(isWslUserActFor('Ubuntu')).toBe(true)
        noteWslDistroMayHaveStopped('Ubuntu')
      },
      { onSettled: noteWslDistroWoken }
    )

    expect(insideAct).toEqual([false, false])
  })
})
