import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutOfProcessLauncher } from './daemon-out-of-process-launcher'
import type * as AppImageLaunch from './daemon-appimage-launch'

const { prepare, resolveLaunch } = vi.hoisted(() => ({
  prepare: vi.fn(),
  resolveLaunch: vi.fn()
}))
vi.mock('./daemon-replacement-preflight', () => ({ prepareDaemonReplacement: prepare }))
vi.mock('./daemon-appimage-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof AppImageLaunch>()),
  resolveAppImageDaemonLaunch: resolveLaunch
}))
vi.mock('./daemon-launch-paths', () => ({
  getDaemonEntryPath: () => '/tmp/.mount_orcaAbC/resources/entry.js',
  probeDaemonSocket: vi.fn()
}))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = (): Promise<void> => Promise.reject(new Error('no daemon'))
    disconnect = (): void => {}
  }
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getAppPath: () => '/app', getVersion: () => '1.0.0' })
}))

afterEach(() => vi.clearAllMocks())

async function expectedIdentity(): Promise<unknown> {
  prepare.mockResolvedValue({ adopted: true, shutdown: vi.fn() })
  await createOutOfProcessLauncher('/run')('/run/sock', '/run/token')
  return prepare.mock.calls[0][0].entryPath
}

describe('daemon launch identity', () => {
  it('matches a surviving own-mount daemon by its AppImage file', async () => {
    resolveLaunch.mockReturnValue({
      appImagePath: '/apps/Orca.AppImage',
      entryPathInAppDir: 'resources/entry.js',
      appPathInAppDir: 'resources/app.asar',
      appVersion: '1.0.0'
    })
    expect(await expectedIdentity()).toBe('/apps/Orca.AppImage/resources/entry.js')
  })

  it('keeps the entry path everywhere else', async () => {
    resolveLaunch.mockReturnValue(null)
    expect(await expectedIdentity()).toBe('/tmp/.mount_orcaAbC/resources/entry.js')
  })
})
