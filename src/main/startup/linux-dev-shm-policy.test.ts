import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, statfsSyncMock, breadcrumbMock } = vi.hoisted(() => ({
  appMock: {
    commandLine: {
      appendSwitch: vi.fn(),
      hasSwitch: vi.fn(() => false)
    }
  },
  statfsSyncMock: vi.fn(),
  breadcrumbMock: vi.fn()
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  statfsSync: statfsSyncMock
}))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: breadcrumbMock
}))

const MIB = 1024 * 1024
const originalPlatform = process.platform
const originalOverride = process.env.ORCA_DEV_SHM

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function mockDevShm(totalMib: number, freeMib: number): void {
  // statfs reports sizes in blocks; use 4 KiB blocks like tmpfs.
  const bsize = 4096
  statfsSyncMock.mockReturnValue({
    bsize,
    blocks: (totalMib * MIB) / bsize,
    bavail: (freeMib * MIB) / bsize
  })
}

beforeEach(() => {
  vi.resetModules()
  appMock.commandLine.appendSwitch.mockReset()
  appMock.commandLine.hasSwitch.mockReset()
  appMock.commandLine.hasSwitch.mockReturnValue(false)
  statfsSyncMock.mockReset()
  breadcrumbMock.mockReset()
  delete process.env.ORCA_DEV_SHM
})

afterEach(() => {
  setPlatform(originalPlatform)
  if (originalOverride === undefined) {
    delete process.env.ORCA_DEV_SHM
  } else {
    process.env.ORCA_DEV_SHM = originalOverride
  }
})

describe('configureLinuxDevShmUsage', () => {
  it('moves Chromium shared memory off a Docker-default 64 MB /dev/shm', async () => {
    setPlatform('linux')
    mockDevShm(64, 60)
    const { configureLinuxDevShmUsage } = await import('./linux-dev-shm-policy')

    configureLinuxDevShmUsage()

    expect(statfsSyncMock).toHaveBeenCalledWith('/dev/shm')
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-dev-shm-usage')
    expect(breadcrumbMock).toHaveBeenCalledWith('dev_shm_policy', {
      devShmTotalMB: 64,
      devShmFreeMB: 60,
      devShmUsageDisabled: true,
      reason: 'small'
    })
  })

  it('leaves a normally sized /dev/shm on the fast shared-memory path', async () => {
    setPlatform('linux')
    mockDevShm(8192, 8000)
    const { configureLinuxDevShmUsage } = await import('./linux-dev-shm-policy')

    configureLinuxDevShmUsage()

    expect(appMock.commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(breadcrumbMock).toHaveBeenCalledWith('dev_shm_policy', {
      devShmTotalMB: 8192,
      devShmFreeMB: 8000,
      devShmUsageDisabled: false,
      reason: 'ok'
    })
  })

  it('disables /dev/shm usage when the mount is missing', async () => {
    setPlatform('linux')
    statfsSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const { configureLinuxDevShmUsage } = await import('./linux-dev-shm-policy')

    configureLinuxDevShmUsage()

    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-dev-shm-usage')
    expect(breadcrumbMock).toHaveBeenCalledWith('dev_shm_policy', {
      devShmUsageDisabled: true,
      reason: 'unreadable'
    })
  })

  it('honors ORCA_DEV_SHM=off on a small mount and =force on a large one', async () => {
    setPlatform('linux')
    mockDevShm(64, 60)
    process.env.ORCA_DEV_SHM = 'off'
    const { configureLinuxDevShmUsage } = await import('./linux-dev-shm-policy')
    configureLinuxDevShmUsage()
    expect(appMock.commandLine.appendSwitch).not.toHaveBeenCalled()

    mockDevShm(8192, 8000)
    process.env.ORCA_DEV_SHM = 'force'
    configureLinuxDevShmUsage()
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-dev-shm-usage')
  })

  it('does not append the switch twice when it is already on the command line', async () => {
    setPlatform('linux')
    mockDevShm(64, 60)
    appMock.commandLine.hasSwitch.mockReturnValue(true)
    const { configureLinuxDevShmUsage } = await import('./linux-dev-shm-policy')

    configureLinuxDevShmUsage()

    expect(appMock.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('is a no-op off Linux', async () => {
    setPlatform('darwin')
    const { configureLinuxDevShmUsage } = await import('./linux-dev-shm-policy')

    configureLinuxDevShmUsage()

    expect(statfsSyncMock).not.toHaveBeenCalled()
    expect(appMock.commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(breadcrumbMock).not.toHaveBeenCalled()
  })
})

describe('desktop startup wiring', () => {
  it('runs the /dev/shm policy for every launch before app ready, GPU fallback included', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    const call = source.indexOf('\n  configureLinuxDevShmUsage()\n')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(source.indexOf('\n  maybeApplyGpuFallbackForThisLaunch()\n'))
  })
})
