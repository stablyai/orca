import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'

const { listRunningWslDistrosAsync } = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean }) => Promise<string[]>>()
}))

vi.mock('../wsl', () => ({
  listWslDistrosAsync: async () => ['Ubuntu'],
  listRunningWslDistrosAsync
}))

describe('WSL CLI discovery running-distro probe', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-running-'))
    listRunningWslDistrosAsync.mockReset()
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  const reconcile = (
    repair: () => Promise<never>
  ): ReturnType<typeof reconcileManagedWslCliRegistrations> =>
    reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath,
      appVersion: '1.4.212',
      getHostLauncherTarget: async () => 'C:\\Orca\\orca.exe',
      createInstaller: () => ({ repairManagedRegistration: repair })
    })

  it('refuses an unconfirmed running list and retries discovery on the next launch', async () => {
    const repair = vi.fn(async (): Promise<never> => {
      throw new Error('guest probe failed')
    })
    listRunningWslDistrosAsync.mockRejectedValueOnce(
      new Error('WSL running-distro discovery is unavailable.')
    )

    await expect(reconcile(repair)).resolves.toEqual([])
    expect(listRunningWslDistrosAsync).toHaveBeenCalledWith({ requireConfirmed: true })
    expect(repair).not.toHaveBeenCalled()

    listRunningWslDistrosAsync.mockResolvedValueOnce(['Ubuntu'])
    await reconcile(repair)
    expect(repair).toHaveBeenCalledOnce()
  })
})
