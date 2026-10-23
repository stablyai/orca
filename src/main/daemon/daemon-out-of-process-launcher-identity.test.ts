import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutOfProcessLauncher } from './daemon-out-of-process-launcher'
import type * as AppImageLaunch from './daemon-appimage-launch'

const { prepare, resolveLaunch, resolveGeneration, launchChild, waitForCopy } = vi.hoisted(() => ({
  prepare: vi.fn(),
  resolveLaunch: vi.fn(),
  resolveGeneration: vi.fn((): unknown => null),
  launchChild: vi.fn(),
  waitForCopy: vi.fn(async () => false)
}))
vi.mock('../cli/appimage-copy-pre-extraction', () => ({
  waitForAppImageCopyPreExtraction: waitForCopy
}))
vi.mock('./daemon-launched-child', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  launchDaemonChild: launchChild
}))
vi.mock('./macos-daemon-launchd', () => ({ launchMacDaemonFromStableBundle: async () => null }))
vi.mock('./daemon-host-relocation', () => ({
  materializeRelocatedDaemonHost: () => null,
  pruneDaemonHostStaging: () => {}
}))
vi.mock('./daemon-appimage-generation-launch', () => ({
  resolveAppImageGenerationDaemonLaunch: resolveGeneration
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
  getAppEnvironment: () => ({
    getAppPath: () => '/app',
    getVersion: () => '1.0.0',
    getPath: () => '/user-data'
  })
}))

const GENERATION = {
  generationRoot: '/cache/ns/gen',
  nodePath: '/cache/ns/gen/resources/node-runtime/bin/node',
  entryPath: '/cache/ns/gen/resources/entry.js',
  identityPath: '/apps/Orca.AppImage/resources/entry.js'
}

afterEach(() => {
  vi.clearAllMocks()
  resolveGeneration.mockReturnValue(null)
  waitForCopy.mockResolvedValue(false)
})

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

  it('matches by the AppImage file when the daemon runs on the extracted copy', async () => {
    resolveLaunch.mockReturnValue(null)
    resolveGeneration.mockReturnValue({ launch: GENERATION })
    expect(await expectedIdentity()).toBe('/apps/Orca.AppImage/resources/entry.js')
  })
})

describe('daemon launch host on an AppImage', () => {
  async function launchedWith(): Promise<Record<string, unknown>> {
    prepare.mockResolvedValue(null)
    launchChild.mockRejectedValue(new Error('stop after the launch decision'))
    await expect(createOutOfProcessLauncher('/run')('/run/sock', '/run/token')).rejects.toThrow(
      'stop after the launch decision'
    )
    return launchChild.mock.calls[0][0]
  }

  it('hands the launch the extracted copy to run on', async () => {
    resolveLaunch.mockReturnValue(null)
    resolveGeneration.mockReturnValue({ launch: GENERATION })
    expect(await launchedWith()).toMatchObject({ extractedGeneration: GENERATION })
  })

  it('says why a new AppImage daemon stays on Electron', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolveLaunch.mockReturnValue(null)
      resolveGeneration.mockReturnValue({ fallback: 'no-extracted-copy' })
      expect(await launchedWith()).toMatchObject({ extractedGeneration: undefined })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('AppImage daemon host fallback reason=no-extracted-copy')
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('runs on the copy this launch is still unpacking when it lands within the wait', async () => {
    resolveLaunch.mockReturnValue(null)
    resolveGeneration
      .mockReturnValueOnce({ fallback: 'no-extracted-copy' })
      .mockReturnValue({ launch: GENERATION })
    waitForCopy.mockResolvedValue(true)
    expect(await launchedWith()).toMatchObject({ extractedGeneration: GENERATION })
    expect(waitForCopy).toHaveBeenCalledTimes(1)
  })

  it('waits for no copy when the existing daemon is kept', async () => {
    resolveLaunch.mockReturnValue(null)
    resolveGeneration.mockReturnValue({ fallback: 'no-extracted-copy' })
    await expectedIdentity()
    expect(waitForCopy).not.toHaveBeenCalled()
  })

  it('says nothing when the existing daemon is kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolveLaunch.mockReturnValue(null)
      resolveGeneration.mockReturnValue({ fallback: 'no-extracted-copy' })
      await expectedIdentity()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
