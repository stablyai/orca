import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl-background-distro-gate'

const mocks = vi.hoisted(() => ({
  runWslProcess: vi.fn(),
  readWslDistroRunningState: vi.fn()
}))
vi.mock('./wsl-runner', () => ({ runWslProcess: mocks.runWslProcess }))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))

import { readWslGuestProcessTable } from './wsl-guest-process-table'
import { runAsWslUserAct } from './wsl-unc-access-gate'

describe('readWslGuestProcessTable never boots a stopped distro (E9)', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.runWslProcess.mockReset().mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    mocks.readWslDistroRunningState.mockReset().mockResolvedValue('stopped')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('reports an empty table for a stopped distro without listing it', async () => {
    await expect(readWslGuestProcessTable('Ubuntu')).resolves.toEqual([])
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('reports an unreadable table when WSL cannot say whether the distro runs', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('unverifiable')
    await expect(readWslGuestProcessTable('Ubuntu')).resolves.toBeNull()
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('lists a running distro, and a user move may list a stopped one', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    await readWslGuestProcessTable('Ubuntu')
    expect(mocks.runWslProcess).toHaveBeenCalledTimes(1)

    mocks.readWslDistroRunningState.mockResolvedValue('stopped')
    await runAsWslUserAct('Debian', () => readWslGuestProcessTable('Debian'))
    expect(mocks.runWslProcess).toHaveBeenCalledTimes(2)
  })
})
