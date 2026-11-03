import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallState, CliInstallStatus } from '../../shared/cli-install-types'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
  isAppImageRegistrationOwnedBySibling: vi.fn(),
  resolveAppImageCacheKey: vi.fn(),
  resolveAppImageRuntimeIdentity: vi.fn()
}))

vi.mock('./cli-installer', () => ({
  CliInstaller: class {
    getStatus = mocks.getStatus
    install = mocks.install
    isAppImageRegistrationOwnedBySibling = mocks.isAppImageRegistrationOwnedBySibling
  }
}))

vi.mock('../updater/linux-package/appimage-runtime-identity', () => ({
  resolveAppImageRuntimeIdentity: mocks.resolveAppImageRuntimeIdentity
}))

vi.mock('./appimage-extracted-root', () => ({
  resolveAppImageCacheKey: mocks.resolveAppImageCacheKey
}))

import {
  inspectAndRepairLocalCliStatus,
  repairStaleLocalAppImageCliRegistration,
  resetStaleAppImageRepairState
} from './local-cli-registration-coordinator'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function makeStatus(state: CliInstallState): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: 'orca-ide',
    commandPath: '/home/me/.local/bin/orca-ide',
    pathDirectory: '/home/me/.local/bin',
    pathConfigured: true,
    launcherPath: '/cache/current/resources/bin/orca-ide',
    installMethod: 'symlink',
    supported: true,
    state,
    currentTarget: state === 'not_installed' ? null : '/cache/old/resources/bin/orca-ide',
    unsupportedReason: null,
    detail: null
  }
}

describe('local-cli-registration-coordinator', () => {
  beforeEach(() => {
    resetStaleAppImageRepairState()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mocks.resolveAppImageRuntimeIdentity.mockReturnValue({
      appImagePath: '/opt/Orca.AppImage',
      mountRoot: '/tmp/.mount_Orca'
    })
    mocks.resolveAppImageCacheKey.mockReturnValue('cache-key-v2')
    mocks.isAppImageRegistrationOwnedBySibling.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('repairs a stale AppImage CLI registration on background desktop startup', async () => {
    const stale = makeStatus('stale')
    const installed = makeStatus('installed')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install.mockResolvedValue(installed)

    await expect(repairStaleLocalAppImageCliRegistration()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledOnce()
  })

  it('skips background startup repair when not running from a Linux AppImage', async () => {
    mocks.resolveAppImageRuntimeIdentity.mockReturnValue(null)

    await expect(repairStaleLocalAppImageCliRegistration()).resolves.toBeNull()
    expect(mocks.getStatus).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('leaves sibling-owned AppImage CLI registrations untouched', async () => {
    const stale = makeStatus('stale')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.isAppImageRegistrationOwnedBySibling.mockReturnValue(true)

    await expect(inspectAndRepairLocalCliStatus()).resolves.toBe(stale)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('backs off after a failed repair before retrying', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    const stale = makeStatus('stale')
    const installed = makeStatus('installed')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install.mockRejectedValueOnce(new Error('disk busy')).mockResolvedValueOnce(installed)

    await expect(inspectAndRepairLocalCliStatus()).resolves.toBe(stale)
    await expect(inspectAndRepairLocalCliStatus()).resolves.toBe(stale)
    expect(mocks.install).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    await expect(inspectAndRepairLocalCliStatus()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })
})
