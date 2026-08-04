/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as UpdaterModule from './updater'
import type * as RecoveryModule from './linux-package-update-recovery'
import type { UpdateStatus } from '../shared/types'

type RevalidationVerdict = Awaited<
  ReturnType<typeof RecoveryModule.revalidateLinuxPackageForInstall>
>

// Captured before any vi.useFakeTimers() call: the only handle left that still yields to libuv.
const realSetTimeout = globalThis.setTimeout

type StagedLinuxPackages = {
  cacheRoot: string
  debPath: string
  debSha512: string
  rpmPath: string
  rpmSha512: string
}

/**
 * Stages real packages inside a real updater cache: every install re-proves the retained digest by
 * streaming the file off disk, so a path that never existed would abort before reaching the native
 * updater. Returns the actual digests for the download events.
 */
function stageLinuxUpdateCache(): StagedLinuxPackages {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'orca-updater-cache-'))
  const pendingDir = join(cacheRoot, 'orca-updater', 'pending')
  mkdirSync(pendingDir, { recursive: true })
  const stagePackage = (fileName: string): { path: string; sha512: string } => {
    const packagePath = join(pendingDir, fileName)
    const bytes = Buffer.from(`orca test package ${fileName}`)
    writeFileSync(packagePath, bytes)
    return { path: packagePath, sha512: createHash('sha512').update(bytes).digest('base64') }
  }
  const deb = stagePackage('orca-ide_1.0.61_amd64.deb')
  const rpm = stagePackage('orca-ide-1.0.61.x86_64.rpm')
  return {
    cacheRoot,
    debPath: deb.path,
    debSha512: deb.sha512,
    rpmPath: rpm.path,
    rpmSha512: rpm.sha512
  }
}

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  isMock,
  killAllPtyMock,
  powerMonitorOnMock
} = vi.hoisted(() => {
  const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = appEventHandlers.get(event) ?? []
    handlers.push(handler)
    appEventHandlers.set(event, handlers)
    return appMock
  })

  const appEmit = (event: string, ...args: unknown[]) => {
    for (const handler of appEventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = eventHandlers.get(event) ?? []
    handlers.push(handler)
    eventHandlers.set(event, handlers)
    return autoUpdaterMock
  })

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of eventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const reset = () => {
    appEventHandlers.clear()
    appOn.mockClear()
    eventHandlers.clear()
    on.mockClear()
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
    autoUpdaterMock.downloadUpdate.mockReset()
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockClear()
    autoUpdaterMock.updateConfigPath = undefined
    autoUpdaterMock.allowPrerelease = false
    autoUpdaterMock.allowDowngrade = false
    autoUpdaterMock.disableDifferentialDownload = false
    autoUpdaterMock.autoRunAppAfterInstall = true
    autoUpdaterMock.logger = undefined
    delete (autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    // Why: setup installs the diagnostic logger adapter here; tests drive child stderr through it.
    logger: undefined as { error: (message: unknown) => void } | undefined,
    on,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    updateConfigPath: undefined as string | undefined,
    emit,
    reset
  }

  return {
    appMock: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: appOn,
      emit: appEmit,
      quit: vi.fn()
    },
    browserWindowMock: {
      getAllWindows: vi.fn(() => [])
    },
    nativeUpdaterMock: {
      on: vi.fn()
    },
    autoUpdaterMock,
    isMock: { dev: false },
    killAllPtyMock: vi.fn(),
    powerMonitorOnMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: powerMonitorOnMock },
  shell: { showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() }
}))

const { getLinuxRootPackageTypeMock, recordUpdaterLifecycleMock } = vi.hoisted(() => ({
  getLinuxRootPackageTypeMock: vi.fn<() => 'deb' | 'rpm' | null>(() => null),
  recordUpdaterLifecycleMock: vi.fn()
}))

// Why: only the marker resolver is faked so the real artifact capture/redaction path stays under test.
vi.mock('./linux-update-package-type', () => ({
  getLinuxRootPackageType: getLinuxRootPackageTypeMock
}))

vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

const { fetchChangelogMock } = vi.hoisted(() => ({
  fetchChangelogMock: vi.fn()
}))

vi.mock('./updater-changelog', () => ({
  fetchChangelog: fetchChangelogMock
}))

const { fetchNudgeMock, shouldApplyNudgeMock } = vi.hoisted(() => ({
  fetchNudgeMock: vi.fn(),
  shouldApplyNudgeMock: vi.fn()
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: fetchNudgeMock,
  shouldApplyNudge: shouldApplyNudgeMock
}))

const { armExitWatchdogMock, disarmExitWatchdogMock } = vi.hoisted(() => ({
  armExitWatchdogMock: vi.fn(),
  disarmExitWatchdogMock: vi.fn()
}))

vi.mock('./update-install-exit-watchdog', () => ({
  armUpdateInstallExitWatchdog: armExitWatchdogMock,
  disarmUpdateInstallExitWatchdog: disarmExitWatchdogMock
}))

const { fetchNewerReleaseTagsMock } = vi.hoisted(() => ({
  fetchNewerReleaseTagsMock: vi.fn()
}))

const { chooseLocalBuildMock, startLocalBuildFeedMock, closeLocalBuildFeedMock } = vi.hoisted(
  () => ({
    chooseLocalBuildMock: vi.fn(),
    startLocalBuildFeedMock: vi.fn(),
    closeLocalBuildFeedMock: vi.fn()
  })
)

vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async (...args: unknown[]) => {
    const result = await fetchNewerReleaseTagsMock(...args)
    return Array.isArray(result)
      ? { tags: result, state: result.length > 0 ? 'ready' : 'no-newer' }
      : result
  },
  getReleaseDownloadUrl: (tag: string) =>
    `https://github.com/stablyai/orca/releases/download/${tag}`
}))

vi.mock('./local-builds/local-build-switch', () => ({
  chooseLocalBuild: chooseLocalBuildMock
}))

vi.mock('./local-builds/local-build-feed-server', () => ({
  startLocalBuildFeed: startLocalBuildFeedMock
}))

/** Mirrors AUTO_UPDATE_CHECK_INTERVAL_MS in updater.ts. */
const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

describe('updater', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    armExitWatchdogMock.mockReset()
    disarmExitWatchdogMock.mockReset()
    powerMonitorOnMock.mockReset()
    getLinuxRootPackageTypeMock.mockReset().mockReturnValue(null)
    recordUpdaterLifecycleMock.mockReset()
    fetchNudgeMock.mockReset().mockResolvedValue(null)
    shouldApplyNudgeMock.mockReset().mockReturnValue(false)
    fetchChangelogMock.mockReset().mockResolvedValue(null)
    fetchNewerReleaseTagsMock.mockReset().mockResolvedValue([])
    chooseLocalBuildMock.mockReset()
    closeLocalBuildFeedMock.mockReset()
    startLocalBuildFeedMock.mockReset().mockResolvedValue({
      url: 'http://127.0.0.1:1234/token/',
      close: closeLocalBuildFeedMock
    })
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not load or configure electron-updater during dev setup', async () => {
    isMock.dev = true
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    // Why: E2E dev-mode launches use a default app version that makes electron-updater throw during module load.
    expect(autoUpdaterMock.updateConfigPath).toBeUndefined()
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it.each([
    ['hourly', 'v1.4.160-hourly.202607281400', 'Hourly builds are produced only for macOS.'],
    ['adhoc', 'v1.4.160-adhoc.20260728140533', 'Adhoc builds are produced only for macOS.']
  ] as const)(
    'uses the display label in the mac-only %s pinned-build error',
    async (channel, tag, message) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      try {
        const send = vi.fn()
        const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
        setupAutoUpdater({ webContents: { send } } as never, {
          getLastUpdateCheckAt: () => Date.now()
        })

        checkForUpdatesFromMenu({ channel, targetTag: tag })

        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message,
          userInitiated: true
        })
        expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  it.runIf(process.platform === 'darwin')(
    'allows a validated local build to downgrade through the normal updater lifecycle',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(true)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(true)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'http://127.0.0.1:1234/token/'
      })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({
            state: 'available',
            version: '0.9.0-local.1',
            source: 'local'
          })
        )
      })

      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'http://127.0.0.1:1234/token/'
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(true)

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      checkForUpdatesFromMenu()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
      expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores ordinary release checks after local build selection fails',
    async () => {
      chooseLocalBuildMock.mockRejectedValue(new Error('invalid local build'))
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: 'invalid local build',
          userInitiated: true,
          source: 'local'
        })
      })

      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores ordinary release checks after a local build is unavailable',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-not-available')
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true,
        source: 'local'
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)

      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores ordinary release checks after a local updater failure',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(new Error('local feed failed'))
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: 'local feed failed',
          userInitiated: true,
          source: 'local'
        })
      })
      expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)

      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the automatic check chain alive across a local build session',
    async () => {
      vi.useFakeTimers()
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      autoUpdaterMock.downloadUpdate.mockRejectedValue(new Error('local download failed'))
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'available', source: 'local' })
      )

      // Why: assert through this window rather than the shared updater mock — a status only lands here
      // when this module instance owns the check attempt, so sibling tests' timers can't fake a pass.
      autoUpdaterMock.checkForUpdates.mockReset().mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-not-available')
        return Promise.resolve(undefined)
      })

      // The scheduled release check fires while the local session still owns the feed, so it defers.
      send.mockClear()
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_CHECK_INTERVAL_MS)
      expect(send).not.toHaveBeenCalledWith('updater:status', { state: 'not-available' })

      // A failed local download ends the session and restores the release source.
      downloadUpdate()
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)

      send.mockClear()
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_CHECK_INTERVAL_MS)
      expect(send).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores release checks when an offered local build is dismissed',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu, dismissAvailableUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'available', source: 'local' })
        )
      })

      dismissAvailableUpdate()
      expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:status', { state: 'idle' })

      autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(undefined)
      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the local feed in force when a dismiss lands during a local build download',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      autoUpdaterMock.downloadUpdate.mockResolvedValue(undefined)
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu, dismissAvailableUpdate, downloadUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'available', source: 'local' })
        )
      })

      downloadUpdate()
      dismissAvailableUpdate()

      expect(closeLocalBuildFeedMock).not.toHaveBeenCalled()
      expect(autoUpdaterMock.allowDowngrade).toBe(true)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(true)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'http://127.0.0.1:1234/token/'
      })
    }
  )

  it('leaves a dismissed release update on the release source', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '2.0.0' })
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu, dismissAvailableUpdate } =
      await import('./updater')
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now()
    })

    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'available', version: '2.0.0' })
      )
    })

    dismissAvailableUpdate()

    // Why: a release dismissal is renderer-only state; main must not clear the offer it can still install.
    expect(closeLocalBuildFeedMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('updater:status', { state: 'idle' })
  })

  it('deduplicates identical check errors from the event and rejected promise', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'error', message: 'boom', userInitiated: true })
    })

    const errorStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter((status) => typeof status === 'object' && status !== null && status.state === 'error')

    expect(errorStatuses).toEqual([{ state: 'error', message: 'boom', userInitiated: true }])
  })

  it('surfaces net::ERR_FAILED to user-initiated checks with a friendly message', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
        })
      )
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    // Why: the raw electron-updater message is replaced so we never surface "net::ERR_FAILED" to the UI.
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: 'net::ERR_FAILED' })
    )
  })

  it('shows checking immediately for a user-initiated check while feed pinning is pending', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    const checkingStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) => typeof status === 'object' && status !== null && status.state === 'checking'
      )

    expect(checkingStatuses).toEqual([{ state: 'checking', userInitiated: true }])
  })

  it('keeps background checks event-driven before checking-for-update fires', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
        .some(
          (status) => typeof status === 'object' && status !== null && status.state === 'checking'
        )
    ).toBe(false)

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'checking' })
    )
  })

  it('promotes a pending background check to user-initiated without launching a duplicate check', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('keeps a silent background settle user-initiated after menu promotion', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('settles a manual check when electron-updater resolves without a terminal event', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale update-available event after a silent background settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale checking-for-update event after a silent manual settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    autoUpdaterMock.emit('checking-for-update')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('ignores stale updater events while a new check is still in feed preflight', async () => {
    vi.useFakeTimers()
    let resolveSecondTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'no-newer' })
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveSecondTags = resolve
          })
      )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })

    resolveSecondTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('does not let a stale silent settle finish a later manual check', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('does not let a stale pending update-available block a later silent settle', async () => {
    vi.useFakeTimers()
    let resolveChangelog: (value: null) => void = () => {}
    fetchChangelogMock.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveChangelog = resolve
        })
    )
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.52'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.0.52' })
        })
      }
      return Promise.resolve(undefined)
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchChangelogMock).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('error', new Error('boom'))
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'boom',
        userInitiated: undefined
      })
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })

    sendMock.mockClear()
    resolveChangelog(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.52' })
    )
  })

  it('ignores a stale update-available event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale update-not-available event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('ignores a stale error event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    let resolveSecondTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'no-newer' })
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveSecondTags = resolve
          })
      )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('error', new Error('stale boom'))

    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', message: 'stale boom' })
    )

    resolveSecondTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('times out a manual preflight that never reaches electron-updater events', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    await vi.advanceTimersByTimeAsync(45 * 1000)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'Update check timed out. Try again in a few minutes.',
      userInitiated: true
    })
  })

  it('does not launch electron-updater after a manual preflight timeout settles', async () => {
    vi.useFakeTimers()
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(45 * 1000)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'Update check timed out. Try again in a few minutes.',
      userInitiated: true
    })

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('runs a fresh prerelease check when Shift-click promotes an in-flight stable check', async () => {
    vi.useFakeTimers()
    let resolveStableTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    let resolveStableCheck: () => void = () => {}
    fetchNewerReleaseTagsMock
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveStableTags = resolve
          })
      )
      .mockResolvedValueOnce({ tags: ['v1.4.36-rc.5'], state: 'ready' })
    autoUpdaterMock.checkForUpdates
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStableCheck = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    appMock.getVersion.mockReturnValue('1.4.35')
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu({ includePrerelease: true })

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveStableTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    await vi.advanceTimersByTimeAsync(0)
    resolveStableCheck()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.35', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.36-rc.5'
    })
    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
    ).not.toContainEqual({ state: 'not-available', userInitiated: true })
  })

  it('keeps promoted background promise failures user-initiated after a paired error event', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()
    resolveTags({ tags: [], state: 'no-newer' })

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
        })
      )
    })

    const resultStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) =>
          typeof status === 'object' &&
          status !== null &&
          (status.state === 'idle' || status.state === 'error')
      )

    expect(resultStatuses).toEqual([
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: expect.stringContaining("Couldn't reach the update server")
      })
    ])
  })

  it('deduplicates repeated manual checks while the immediate checking status is active', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
  })

  it('opts into the RC channel when checkForUpdatesFromMenu is called with includePrerelease', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18-rc.1'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    // Why: recent timestamp defers the startup check so we observe updater state before any RC-mode call, without racing.
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const setupFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)

    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.18-rc.1'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls + 1)
  })

  it('pins the generic feed to a perf-tagged prerelease when requested', async () => {
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.4.121-rc.6.perf'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120', 2, {
        includePrerelease: true,
        releaseFilter: 'perf'
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.121-rc.6.perf'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
  })

  it('surfaces no-update feedback when no newer perf-tagged prerelease exists', async () => {
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const setupFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120', 2, {
      includePrerelease: true,
      releaseFilter: 'perf'
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls)
  })

  it('keeps background retries on the stable channel after a perf publishing-window miss', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.121'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenNthCalledWith(2, '1.4.120', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.121'
      })
    })
  })

  it('keeps prerelease publishing-window misses on the generic retry path', async () => {
    appMock.getVersion.mockReturnValue('1.4.120-rc.5')
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'not-ready' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120-rc.5', 2, {
      includePrerelease: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('leaves the feed URL alone for a normal user-initiated check', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const initialFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu({ includePrerelease: false })

    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(initialFeedUrlCalls)
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)
  })

  it('still surfaces updater error events while a download is in flight', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })
    autoUpdaterMock.downloadUpdate.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error('download failed'))
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    sendMock.mockClear()
    downloadUpdate()

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', message: 'download failed' })
    )
  })

  it('surfaces an accepted retry before electron-updater emits download progress', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })
    autoUpdaterMock.downloadUpdate
      .mockRejectedValueOnce(new Error('signature check blocked'))
      .mockImplementationOnce(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    downloadUpdate()
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'signature check blocked'
      })
    })

    sendMock.mockClear()
    downloadUpdate()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'downloading',
      percent: 0,
      version: '1.0.61'
    })

    downloadUpdate()
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('defers quitAndInstall through the shared main-process entrypoint', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(99)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('runs pre-quit cleanup before local PTY cleanup during update install', async () => {
    vi.useFakeTimers()

    const onBeforeQuit = vi.fn()
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(onBeforeQuit.mock.invocationCallOrder[0]).toBeLessThan(
      killAllPtyMock.mock.invocationCallOrder[0]
    )
  })

  it('ignores duplicate quitAndInstall requests while the shared delay is pending', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('ignores duplicate quitAndInstall requests while async pre-quit cleanup is running', async () => {
    vi.useFakeTimers()

    let finishCleanup!: () => void
    const onBeforeQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    quitAndInstall()
    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('recovers quit-for-update state on sync quitAndInstall error event without killing PTYs', async () => {
    vi.useFakeTimers()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      // Why: BaseUpdater dispatches 'error' synchronously inside install() for the common "no staged update filepath" path.
      autoUpdaterMock.emit(
        'error',
        new Error("No update filepath provided, can't quit and install")
      )
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(false)
    // Why: destructive prep runs only after quitAndInstall returns still in progress; sync recovery clears flags first so PTYs stay alive.
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        // Why: a pre-commit install failure is not fixed by restarting, so the copy must not
        // suggest it — except on macOS, where quitting does re-stage a Squirrel update.
        message:
          process.platform === 'darwin'
            ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
            : 'Could not start the update installer. Orca remains open.'
      })
    )
  })

  it('does not recover quit-for-update state from late errors after install commit', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu, quitAndInstall, isQuittingForUpdate } =
      await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    // Why: reach the downloaded state so a late post-commit error isn't mistaken for a download/install UI failure.
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

    // Why: on macOS install commits only once Squirrel is ready; mark it ready so this test covers the post-commit path on all platforms.
    if (process.platform === 'darwin') {
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')
      nativeDownloadedHandler?.()
    }

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
      )
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)

    sendMock.mockClear()
    autoUpdaterMock.emit('error', new Error('late post-commit install error'))

    expect(isQuittingForUpdate()).toBe(true)
    // Why: handoff still owns the process after commit — no recovery message or check/download error status.
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('arms the forced-exit watchdog once the install commits', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
    // Why: on macOS install commits only once Squirrel is ready; mark it ready so this test covers the committed path on all platforms.
    if (process.platform === 'darwin') {
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')
      nativeDownloadedHandler?.()
    }

    expect(armExitWatchdogMock).not.toHaveBeenCalled()

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    // Why: the installer (ShipIt/NSIS) waits for this process to exit; the watchdog prevents a wedged async shutdown from stranding the update.
    expect(armExitWatchdogMock).toHaveBeenCalledTimes(1)
  })

  it('disarms the forced-exit watchdog when sync install error recovery keeps the app open', async () => {
    vi.useFakeTimers()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit(
        'error',
        new Error("No update filepath provided, can't quit and install")
      )
    })

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(isQuittingForUpdate()).toBe(false)
    // Why: recovery leaves the app running; a live watchdog would force-exit a healthy session 20s later.
    expect(armExitWatchdogMock).not.toHaveBeenCalled()
    expect(disarmExitWatchdogMock).toHaveBeenCalled()
  })

  it('does not treat pre-native autoUpdater errors as quitAndInstall recovery', async () => {
    vi.useFakeTimers()

    let finishCleanup!: () => void
    const onBeforeQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      onBeforeQuit,
      getLastUpdateCheckAt: () => Date.now()
    })
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(isQuittingForUpdate()).toBe(true)

    sendMock.mockClear()
    // Why: unrelated error during pre-quit cleanup must not clear quittingForUpdate or emit install-recovery status (native not invoked).
    autoUpdaterMock.emit('error', new Error('pre-native concurrent error'))

    expect(isQuittingForUpdate()).toBe(true)
    expect(sendMock).not.toHaveBeenCalled()

    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)
  })

  it('runs a startup check immediately when the last background check is stale', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('starts nudge polling only after updater initialization is complete', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.on).toHaveBeenCalled()
    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
      fetchNudgeMock.mock.invocationCallOrder[0]
    )
    expect(autoUpdaterMock.on.mock.invocationCallOrder[0]).toBeLessThan(
      fetchNudgeMock.mock.invocationCallOrder[0]
    )
  })

  it('waits until the remaining interval before the next background check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 23 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('deduplicates rapid focus-triggered daily checks before checking status arrives', async () => {
    let lastUpdateCheckAt = Date.now()
    const mainWindow = { webContents: { send: vi.fn() } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => lastUpdateCheckAt
    })

    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  it('does not persist lastUpdateCheckAt when a focus-triggered check fails benignly', async () => {
    let lastUpdateCheckAt = Date.now()
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => lastUpdateCheckAt,
      setLastUpdateCheckAt
    })

    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('retries background checks sooner after a failed automatic check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
  })

  it('reschedules the next automatic check 24 hours after finding an available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null
    })

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
  })

  it('does not leak a nudge marker into a later ordinary update cycle', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    // Why: recent timestamp defers the startup check so the nudge check runs without hitting the 'checking' guard.
    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statusCalls = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)

      expect(statusCalls).toContainEqual({ state: 'checking', userInitiated: true })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })

    autoUpdaterMock.emit('update-available', { version: '1.0.62' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.62',
      changelog: null
    })
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ version: '1.0.62', activeNudgeId: 'campaign-1' })
    )
  })

  it('preserves the pending nudge marker across a later background check', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('does not trigger a nudge check while an updater check is already in progress', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      // Stay in 'checking' state — don't resolve
      return new Promise(() => {})
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    // Wait for the startup nudge check to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The 'checking' guard should block runBackgroundUpdateCheck while the startup check is in progress.
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('respects the activation/resume cooldown for nudge checks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-12T12:00:00Z'))

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    // Wait for the startup nudge check to complete
    await vi.advanceTimersByTimeAsync(0)

    // Startup check set lastNudgeCheckAt, so browser-window-focus is blocked by the 5-minute cooldown.
    fetchNudgeMock.mockClear()
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    // fetchNudge should NOT have been called again — cooldown blocks it
    expect(fetchNudgeMock).not.toHaveBeenCalled()

    // Advance past the cooldown
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
  })

  it('clears pending nudge campaign when the follow-up check ends in not-available', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    // Nudge was applied — pending id was set
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    // Now simulate the updater finding no update
    autoUpdaterMock.emit('update-not-available')

    // Pending cleared and campaign auto-dismissed so it doesn't re-fire next poll cycle.
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
  })

  it('clears pending nudge campaign when a silent follow-up check settles not-available', async () => {
    vi.useFakeTimers()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(pendingNudgeId).toBe(null)
  })

  it('auto-dismisses nudge campaign when the follow-up check errors out', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    // Simulate an error during the nudge-triggered check
    autoUpdaterMock.emit('error', new Error('network timeout'))

    // Campaign should be auto-dismissed to prevent re-fire loop
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })

  it('does not preserve a pending nudge for ordinary manifest transition errors', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()
    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.reject(missingManifest)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    })

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
  })

  it('moves pending nudge to dismissed when dismissNudge is called', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, dismissNudge } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    // Simulate update found, then user dismisses
    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    dismissNudge()

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })

  // Why: a no-op verifyUpdateCodeSignature override would silently accept every installer; keep electron-updater's Authenticode check (issue #631 resolved).
  it('does not disable Windows Authenticode verification on win32', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    const { setupAutoUpdater } = await import('./updater')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    expect((autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature).toBeUndefined()
  })

  it('does not override verifyUpdateCodeSignature on non-Windows platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })

    const { setupAutoUpdater } = await import('./updater')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    expect((autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature).toBeUndefined()
  })

  // Why: native github provider + allowPrerelease traps RC users on the RC channel, so resolve the newest tag ourselves and pin the generic feed to it.
  it('repins the generic feed to the newest RC tag for a prerelease user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17-rc.1')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.17-rc.2'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    // Setup pins the default generic feed; resolver only runs per check.
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17-rc.1', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.17-rc.2'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  // Why: RC users couldn't upgrade to newer stable (PR #1053); resolver must pick the stable tag for a prerelease user.
  it('repins the generic feed to a newer stable tag for a prerelease user', async () => {
    appMock.getVersion.mockReturnValue('1.3.19-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.19'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.19'
      })
    })
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)
  })

  // Why: if the atom resolver fails or finds nothing newer, fall back to /releases/latest/download so the check completes as "not-available" instead of erroring.
  it('falls back to /releases/latest/download when the atom resolver returns null', async () => {
    appMock.getVersion.mockReturnValue('1.3.19-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue([])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
  })

  it('keeps unavailable release probes on generic copy without launching a moving feed', async () => {
    appMock.getVersion.mockReturnValue('1.4.141')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const feedCallsBeforeCheck = autoUpdaterMock.setFeedURL.mock.calls.length
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.setFeedURL.mock.calls.slice(feedCallsBeforeCheck)).not.toContainEqual([
      {
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      }
    ])
  })

  it('keeps Atom feed outages on the existing moving-feed fallback', async () => {
    appMock.getVersion.mockReturnValue('1.4.141')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'feed'
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error' })
    )
  })

  it('uses last-good concrete feed when a user-initiated check lands during publishing', async () => {
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const feedCallsBeforeCheck = autoUpdaterMock.setFeedURL.mock.calls.length
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
      expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    })
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
    expect(autoUpdaterMock.setFeedURL.mock.calls.slice(feedCallsBeforeCheck)).not.toContainEqual([
      {
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      }
    ])
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error' })
    )
  })

  it('can offer an older fully published update while the newest release is publishing', async () => {
    appMock.getVersion.mockReturnValue('1.4.25')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.4.26' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.26',
        changelog: null
      })
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
  })

  it('keeps background publishing-window fallback on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    autoUpdaterMock.emit('update-not-available')

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps silent publishing-window fallback on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps background checks retryable while newer release assets are still publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.26', 1, {
      includePrerelease: false
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it.each([
    {
      caseName: 'stable-not-ready',
      version: '1.4.26',
      candidateLimit: 1,
      includePrerelease: false,
      result: { tags: [], state: 'not-ready' as const }
    },
    {
      caseName: 'prerelease-not-ready',
      version: '1.4.26-rc.1',
      candidateLimit: 2,
      includePrerelease: true,
      result: { tags: [], state: 'not-ready' as const }
    },
    {
      caseName: 'stable-manifest-unavailable',
      version: '1.4.26',
      candidateLimit: 1,
      includePrerelease: false,
      result: { tags: [], state: 'unavailable' as const, unavailableReason: 'manifest' as const }
    }
  ])(
    'keeps a nudge campaign pending for $caseName',
    async ({ version, candidateLimit, includePrerelease, result }) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
      appMock.getVersion.mockReturnValue(version)
      fetchNudgeMock.mockResolvedValueOnce({ id: 'campaign-1', minVersion: '1.0.0' })
      fetchNudgeMock.mockResolvedValue(null)
      shouldApplyNudgeMock.mockReturnValue(true)
      fetchNewerReleaseTagsMock
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({ tags: ['v1.4.27'], state: 'ready' })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return Promise.resolve(undefined)
      })
      let pendingNudgeId: string | null = null
      const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
        pendingNudgeId = id
      })
      const setDismissedUpdateNudgeId = vi.fn()
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater(mainWindow as never, {
        getLastUpdateCheckAt: () => Date.now(),
        getPendingUpdateNudgeId: () => pendingNudgeId,
        getDismissedUpdateNudgeId: () => null,
        setPendingUpdateNudgeId,
        setDismissedUpdateNudgeId
      })

      await vi.waitFor(() => {
        expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
      })
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(version, candidateLimit, {
        includePrerelease
      })
      expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
      expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
      expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
      expect(pendingNudgeId).toBe('campaign-1')

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('update-available', { version: '1.4.27' })
      await vi.advanceTimersByTimeAsync(0)

      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.27',
        changelog: null,
        activeNudgeId: 'campaign-1'
      })
      expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    }
  )

  it('does not dismiss a nudge when last-good fallback is current during publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
      }
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('does not attach nudge dismissal to an older last-good available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.25')
    fetchNudgeMock.mockResolvedValueOnce({ id: 'campaign-1', minVersion: '1.0.0' })
    fetchNudgeMock.mockResolvedValue(null)
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.4.26' })
        })
      }
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, dismissNudge } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.26',
        changelog: null
      })
    })
    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    const lastGoodStatus = statuses.find(
      (status) => status.state === 'available' && status.version === '1.4.26'
    )
    if (lastGoodStatus && 'activeNudgeId' in lastGoodStatus) {
      dismissNudge()
    }

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('retries a prerelease check once against the previous feed tag when the manifest is missing', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return Promise.reject(missingManifest)
      }
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.51-rc.7'
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.51-rc.6'
      })
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
  })

  it('surfaces a promise-only prerelease fallback failure after the primary error event', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  it('allows the short background retry to launch after a promise-only prerelease fallback failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        return Promise.reject(missingManifest)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('does not let user-initiated promise-only fallback failures taint the next background check', async () => {
    let lastUpdateCheckAt = Date.now()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        return Promise.reject(missingManifest)
      }
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => lastUpdateCheckAt })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    sendMock.mockClear()
    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available' })
      expect(statuses).not.toContainEqual({ state: 'checking', userInitiated: true })
      expect(statuses).not.toContainEqual({ state: 'not-available', userInitiated: true })
    })
  })

  it('preserves user-initiated state for delayed prerelease fallback not-available', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return Promise.reject(missingManifest)
      }
      setTimeout(() => {
        autoUpdaterMock.emit('update-not-available')
      }, 10)
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.advanceTimersByTimeAsync(10)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
  })

  it('ignores a delayed primary error after a promise-launched prerelease fallback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        setTimeout(() => {
          autoUpdaterMock.emit('error', missingManifest)
        }, 10)
        return Promise.reject(missingManifest)
      }
      if (callCount === 2) {
        setTimeout(() => {
          autoUpdaterMock.emit('update-not-available')
        }, 20)
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.advanceTimersByTimeAsync(30)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('handles an event-only fallback error after a promise-only primary failure', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifestMessage =
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    const primaryMissingManifest = new Error(missingManifestMessage)
    const fallbackMissingManifest = new Error(missingManifestMessage)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        return Promise.reject(primaryMissingManifest)
      }
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', fallbackMissingManifest)
      })
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses.at(-1)).toEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  it('suppresses a delayed background fallback error after the fallback promise handled it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        setTimeout(() => {
          autoUpdaterMock.emit('error', missingManifest)
        }, 10)
        return Promise.reject(missingManifest)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    sendMock.mockClear()
    await vi.advanceTimersByTimeAsync(10)

    const statusesAfterLateError = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterLateError).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: missingManifest.message })
    )

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('suppresses a delayed user fallback error after the fallback promise handled it', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      setTimeout(() => {
        autoUpdaterMock.emit('error', missingManifest)
      }, 10)
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    sendMock.mockClear()
    await vi.advanceTimersByTimeAsync(10)

    const statusesAfterLateError = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterLateError).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: missingManifest.message })
    )
  })

  it('keeps background prerelease fallback not-available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available' })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps user prerelease fallback not-available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps user prerelease fallback available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.5')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.3.51-rc.6' })
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'available',
        version: '1.3.51-rc.6',
        changelog: null
      })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('surfaces the failure when the bounded prerelease fallback also misses its manifest', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', missingManifest)
      })
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  // Why: /releases/latest/download is a moving redirect; a relative ZIP URL from an old manifest can resolve against a newer release and 404.
  it('pins the generic feed to a concrete stable tag for a stable user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.3.18'
    })
  })

  // Why: native GitHub provider can pick cancelled prerelease tags with missing manifests, so keep the manifest-probed generic feed.
  it('uses the manifest-probed generic feed after a Shift-click RC opt-in', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18-rc.1'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.3.18-rc.1'
    })
  })

  describe('linux root package install recovery', () => {
    let staged: StagedLinuxPackages
    let EXIT_127: string

    // Why: the pre-install digest re-proof streams the package off real disk. Fake timers never
    // advance libuv, so the quit timer needs fake time while the read needs real event-loop turns.
    const settleQuitAndInstall = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(100)
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => realSetTimeout(resolve, 0))
      }
      await vi.advanceTimersByTimeAsync(0)
    }

    beforeEach(() => {
      staged = stageLinuxUpdateCache()
      vi.stubEnv('XDG_CACHE_HOME', staged.cacheRoot)
      EXIT_127 = `Command failed: /usr/bin/pkexec /usr/bin/dpkg -i ${staged.debPath}, exited with code 127`
    })

    afterEach(() => {
      vi.doUnmock('./linux-package-update-recovery')
      vi.unstubAllEnvs()
      rmSync(staged.cacheRoot, { recursive: true, force: true })
    })

    /**
     * Holds the pre-install re-proof open so a verdict can be delivered at an exact point in the
     * cycle. Only that call is replaced — the artifact state stays real. Must precede startUpdater.
     */
    const holdRevalidation = (): {
      settle: (verdict: RevalidationVerdict) => void
      fail: (error: Error) => void
    } => {
      let pending: {
        resolve: (verdict: RevalidationVerdict) => void
        reject: (error: Error) => void
      } | null = null
      vi.doMock('./linux-package-update-recovery', async () => {
        const actual = await vi.importActual<typeof RecoveryModule>(
          './linux-package-update-recovery'
        )
        return {
          ...actual,
          revalidateLinuxPackageForInstall: vi.fn(
            () =>
              new Promise<RevalidationVerdict>((resolve, reject) => {
                pending = { resolve, reject }
              })
          )
        }
      })
      return {
        settle: (verdict) => {
          pending?.resolve(verdict)
          pending = null
        },
        fail: (error) => {
          pending?.reject(error)
          pending = null
        }
      }
    }

    const lastStatus = (send: ReturnType<typeof vi.fn>): UpdateStatus | undefined =>
      send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]

    // Why: macOS keeps the restart advice because quitting does re-stage a Squirrel update.
    const PRE_COMMIT_FAILURE_MESSAGE =
      process.platform === 'darwin'
        ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
        : 'Could not start the update installer. Orca remains open.'
    const AGENT_STDERR =
      'pkexec: Error executing command as another user: No authentication agent found.'

    const downloadedEvent = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
      version: '1.0.61',
      downloadedFile: staged.debPath,
      files: [{ url: 'orca-ide_1.0.61_amd64.deb', sha512: staged.debSha512 }],
      ...overrides
    })

    const rpmDownloadedEvent = (): Record<string, unknown> =>
      downloadedEvent({
        downloadedFile: staged.rpmPath,
        files: [{ url: 'orca-ide-1.0.61.x86_64.rpm', sha512: staged.rpmSha512 }]
      })

    const startUpdater = async (
      packageType: 'deb' | 'rpm' | null
    ): Promise<{ send: ReturnType<typeof vi.fn>; updater: typeof UpdaterModule }> => {
      getLinuxRootPackageTypeMock.mockReturnValue(packageType)
      vi.useFakeTimers()
      fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const updater = await import('./updater')
      updater.setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })
      return { send, updater }
    }

    const reachDownloaded = async (
      updater: typeof UpdaterModule,
      event: Record<string, unknown>
    ): Promise<void> => {
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', event)
      if (process.platform === 'darwin') {
        const nativeReady = nativeUpdaterMock.on.mock.calls.find(
          ([eventName]) => eventName === 'update-downloaded'
        )?.[1] as (() => void) | undefined
        nativeReady?.()
      }
      await vi.advanceTimersByTimeAsync(0)
    }

    it('disables install-on-quit for deb and rpm root packages', async () => {
      for (const packageType of ['deb', 'rpm'] as const) {
        vi.resetModules()
        autoUpdaterMock.autoInstallOnAppQuit = true
        getLinuxRootPackageTypeMock.mockReturnValue(packageType)
        const { setupAutoUpdater } = await import('./updater')

        setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
          getLastUpdateCheckAt: () => Date.now(),
          installMode: 'interactive'
        })

        expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      }
    })

    it('keeps interactive install-on-quit when no root-package marker is present', async () => {
      autoUpdaterMock.autoInstallOnAppQuit = false
      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'interactive'
      })

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true)
    })

    it('leaves headless serve installs supervisor-controlled', async () => {
      for (const installMode of [
        'supervised-headless-serve',
        'unsupported-headless-serve'
      ] as const) {
        vi.resetModules()
        autoUpdaterMock.autoInstallOnAppQuit = true
        const { setupAutoUpdater } = await import('./updater')

        setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
          getLastUpdateCheckAt: () => Date.now(),
          installMode
        })

        expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      }
    })

    it('sends structured recovery when quitAndInstall throws synchronously', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.logger?.error(`${AGENT_STDERR} target ${staged.debPath}`)
        throw new Error(EXIT_127)
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      // Why: the sync throw ends capture before the catch, so the stashed text must survive.
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: `${AGENT_STDERR} target <package>`,
        recovery: {
          kind: 'linux-package-install',
          packageType: 'deb',
          reason: 'authentication-agent-unavailable',
          version: '1.0.61'
        }
      })
    })

    it('recovers an event-driven pre-commit failure without tearing down the session', async () => {
      const openWindow = { removeAllListeners: vi.fn() }
      browserWindowMock.getAllWindows.mockReturnValue([openWindow] as never)
      const { send, updater } = await startUpdater('rpm')
      await reachDownloaded(updater, rpmDownloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error('Command failed, exited with code 1'))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'Command failed, exited with code 1',
        recovery: {
          kind: 'linux-package-install',
          packageType: 'rpm',
          reason: 'package-install-failed',
          version: '1.0.61'
        }
      })
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(openWindow.removeAllListeners).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(disarmExitWatchdogMock).toHaveBeenCalled()
    })

    it('keeps the generic install-failure copy when no artifact was retained', async () => {
      const { send, updater } = await startUpdater('deb')
      // Release metadata without a digest must not enable cached-package recovery.
      await reachDownloaded(
        updater,
        downloadedEvent({ files: [{ url: 'orca-ide_1.0.61_amd64.deb' }] })
      )
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: PRE_COMMIT_FAILURE_MESSAGE
      })
      expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
        'linux_package_install_failed',
        expect.anything(),
        expect.anything()
      )
    })

    it('advises a restart only for a failure before the native invoke', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      // The source calls this out as the pre-native "cleanup/tracing exception" case.
      recordUpdaterLifecycleMock.mockImplementation((event: unknown) => {
        if (event === 'quit_and_install_invoking_native') {
          throw new Error('tracing sink unavailable')
        }
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      })
      expect(updater.isQuittingForUpdate()).toBe(false)
    })

    it('keeps a committed install intact when post-commit cleanup throws', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      // Why: spawnSync already installed the package; a teardown throw must not be reported as failure.
      killAllPtyMock.mockImplementation(() => {
        throw new Error('pty teardown failed')
      })
      send.mockClear()

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'post_commit_cleanup_failed',
        { errorType: 'Error' },
        expect.objectContaining({ level: 'warn' })
      )
      expect(send).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(true)
      expect(armExitWatchdogMock).toHaveBeenCalledTimes(1)
      expect(disarmExitWatchdogMock).not.toHaveBeenCalled()
    })

    it('still suppresses late post-commit errors while an artifact is retained', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await settleQuitAndInstall()
      expect(killAllPtyMock).toHaveBeenCalledTimes(1)

      send.mockClear()
      autoUpdaterMock.emit('error', new Error(EXIT_127))

      expect(send).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(true)
    })

    it('retries the automatic install without redownloading the package', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()
      updater.quitAndInstall()
      await settleQuitAndInstall()

      // Why: a retry usually fails identically; a deduped status would strand the preload restart relay.
      expect(
        send.mock.calls.filter(
          ([channel, status]) =>
            channel === 'updater:status' &&
            (status as { recovery?: { kind?: string } })?.recovery?.kind === 'linux-package-install'
        )
      ).toHaveLength(2)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith('linux_package_recovery_requested', {
        action: 'retry-automatic',
        packageType: 'deb',
        version: '1.0.61'
      })
    })

    // Why: the cache path is user-writable, so the bytes verified when the recovery card
    // rendered are not necessarily the bytes a root package manager would read on retry.
    it('aborts the retry when the retained package no longer matches its digest', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      // The escalation fails, which is what puts the recovery card (and its retry) on screen.
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })
      updater.quitAndInstall()
      await settleQuitAndInstall()
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)

      // A local process swaps the verified package for its own between failure and retry.
      writeFileSync(staged.debPath, Buffer.from('attacker supplied package'))
      send.mockClear()
      killAllPtyMock.mockClear()

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message:
          'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.'
      })
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.objectContaining({ action: 'retry-automatic', reason: 'hash-mismatch' }),
        expect.anything()
      )
    })

    // Why: "Restart to Update" is the common path and can sit unclicked for hours, so the same
    // user-writable package reaches a root installer with a far longer window than any retry.
    it('aborts the first install when the downloaded package was swapped', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      writeFileSync(staged.debPath, Buffer.from('attacker supplied package'))
      send.mockClear()

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message:
          'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.'
      })
      expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.objectContaining({ action: 'restart-to-install', reason: 'hash-mismatch' }),
        expect.anything()
      )
    })

    it('installs normally when the retained package still matches its digest', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(killAllPtyMock).toHaveBeenCalledTimes(1)
      // Why: an abort push here would clear the restart flag mid-quit and re-arm the dirty-buffer
      // prompt against the install that is already committed.
      expect(send).not.toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.anything(),
        expect.anything()
      )
    })

    // Why: hashing 160 MB outlives the cycle it started in, and Check for Updates stays enabled
    // while it runs — a verdict from the old cycle must not replace the card that took over.
    it('drops an abort verdict once a newer check replaced the card', async () => {
      const revalidation = holdRevalidation()
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      // The user gives up waiting and checks again; that check owns the card from here.
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(lastStatus(send)).toMatchObject({ state: 'available', version: '1.0.61' })

      revalidation.settle({ ok: false, reason: 'hash-mismatch' })
      await settleQuitAndInstall()

      // The install is still abandoned — only the stale status is withheld.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(lastStatus(send)).toMatchObject({ state: 'available', version: '1.0.61' })
      // Withholding the status must not also withhold the abort: the renderer armed its restart and
      // would otherwise skip its unsaved-work prompt for the rest of the session.
      expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.objectContaining({ reason: 'hash-mismatch' }),
        expect.anything()
      )
    })

    // Why: EMFILE/EIO during the stream says nothing about the bytes, so the copy must not claim
    // the package changed and the card must keep the actions that still work.
    it('keeps the recovery card usable when the re-proof cannot read the package', async () => {
      const revalidation = holdRevalidation()
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })
      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.settle({ ok: true })
      await settleQuitAndInstall()
      send.mockClear()

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.settle({ ok: false, reason: 'read-failed' })
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(lastStatus(send)).toEqual({
        state: 'error',
        message:
          'Orca could not read the downloaded package. Download the update again, or get it from the official release page.',
        recovery: {
          kind: 'linux-package-install',
          packageType: 'deb',
          reason: 'package-install-failed',
          version: '1.0.61'
        }
      })
    })

    // Why: the re-proof runs before performQuitAndInstall's own error handling, so a rejection
    // there would strand the quit timer and make every later install a silent no-op.
    it('stays installable after a re-proof that rejects outright', async () => {
      const revalidation = holdRevalidation()
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.fail(new Error('hash worker crashed'))
      await settleQuitAndInstall()

      // Fails closed: an unprovable package is not handed to a root package manager.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(lastStatus(send)).toMatchObject({
        state: 'error',
        message:
          'Orca could not read the downloaded package. Download the update again, or get it from the official release page.'
      })

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.settle({ ok: true })
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    // Why: a second click during the multi-second hash must not schedule a parallel install.
    it('ignores a second install request while the digest re-proof runs', async () => {
      const { updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      // Fires the quit timer, which starts the hash; the read itself is still outstanding.
      await vi.advanceTimersByTimeAsync(100)
      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    it('records classification-only lifecycle data for a package install failure', async () => {
      const { updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.logger?.error(`${AGENT_STDERR} target ${staged.debPath}`)
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      const failure = recordUpdaterLifecycleMock.mock.calls.find(
        ([event]) => event === 'linux_package_install_failed'
      )
      expect(failure?.[1]).toEqual({
        packageType: 'deb',
        reason: 'authentication-agent-unavailable',
        exitCode: 127,
        version: '1.0.61',
        errorType: 'Error'
      })
      const durable = JSON.stringify(recordUpdaterLifecycleMock.mock.calls)
      expect(durable).not.toContain(staged.debPath)
      expect(durable).not.toContain('authentication agent')
    })

    it('omits exitCode from lifecycle data when the child status is unparseable', async () => {
      const { updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error('dpkg was interrupted'))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      const failure = recordUpdaterLifecycleMock.mock.calls.find(
        ([event]) => event === 'linux_package_install_failed'
      )
      // Why: an absent key, not an explicit null, keeps the breadcrumb schema honest.
      expect(failure?.[1]).toEqual({
        packageType: 'deb',
        reason: 'package-install-failed',
        version: '1.0.61',
        errorType: 'Error'
      })
      expect(Object.keys(failure?.[1] as object)).not.toContain('exitCode')
    })
  })
})
