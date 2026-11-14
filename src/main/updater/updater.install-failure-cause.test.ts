import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TracerModule from '../observability/tracer'
import type * as UpdaterModule from './updater-service'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  killAllPtyMock,
  recordUpdaterLifecycleMock
} = vi.hoisted(() => {
  const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = appEventHandlers.get(event) ?? []
    handlers.push(handler)
    appEventHandlers.set(event, handlers)
    return appMock
  })

  const appPrependListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = appEventHandlers.get(event) ?? []
    handlers.unshift(handler)
    appEventHandlers.set(event, handlers)
    return appMock
  })

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
    appPrependListener.mockClear()
    eventHandlers.clear()
    on.mockClear()
    autoUpdaterMock.checkForUpdates.mockReset()
    autoUpdaterMock.downloadUpdate.mockReset()
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockClear()
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    emit,
    reset
  }

  return {
    appMock: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.4.162'),
      on: appOn,
      prependListener: appPrependListener,
      quit: vi.fn(),
      exit: vi.fn()
    },
    browserWindowMock: { getAllWindows: vi.fn(() => []) },
    nativeUpdaterMock: { on: vi.fn() },
    autoUpdaterMock,

    killAllPtyMock: vi.fn(),
    recordUpdaterLifecycleMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))
vi.mock('./releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: vi
    .fn()
    .mockResolvedValue({ tags: ['v1.4.241'], state: 'ready' }),
  getReleaseDownloadUrl: (tag: string) =>
    `https://github.com/stablyai/orca/releases/download/${tag}`
}))
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))

vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))
vi.mock('../ipc/pty/kill-all', () => ({ killAllPty: killAllPtyMock }))
vi.mock('./releases/updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))
vi.mock('./nudges/nudge-campaign', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./linux-package/linux-update-package-type', () => ({
  getLinuxPackageType: () => 'non-root',
  getLinuxRootPackageType: () => null,
  isExternallyManagedLinuxInstall: () => false
}))

type CapturedSpan = {
  readonly name: string
  readonly exit: { readonly _tag: string; readonly cause?: string }
}

const originalPlatform = process.platform

let spans: CapturedSpan[]
let tracer: typeof TracerModule | null = null

function capturingSink(): TracerModule.TracerSink {
  return {
    push(record) {
      spans.push(record as CapturedSpan)
    },
    flush() {
      /* no-op */
    },
    close() {
      /* no-op */
    }
  }
}

async function reachDownloaded(): Promise<typeof UpdaterModule> {
  const mainWindow = updaterMainWindow(vi.fn())
  autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
  // Install the sink on the fresh tracer instance the updater will import.
  tracer = await import('../observability/tracer')
  tracer.setActiveSink(capturingSink())
  const updater = await loadUpdaterModule()

  updater.setupAutoUpdater(mainWindow)
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => {
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })
  autoUpdaterMock.emit('checking-for-update')
  autoUpdaterMock.emit('update-available', { version: '1.4.163' })
  await vi.advanceTimersByTimeAsync(0)
  autoUpdaterMock.downloadUpdate.mockResolvedValue([])
  updater.downloadUpdate()
  autoUpdaterMock.emit('update-downloaded', { version: '1.4.163' })
  expect(updater.getUpdateStatus().state).toBe('downloaded')
  return updater
}

warmUpdaterModule()

// DebUpdater can emit install errors synchronously; preserve their cause through recovery.
describe('quitAndInstall failure carries the updater cause', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.4.162')
    appMock.quit.mockReset()
    appMock.isPackaged = true

    killAllPtyMock.mockReset()
    recordUpdaterLifecycleMock.mockReset()
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true
    })
    vi.useFakeTimers()
    spans = []
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    })
    tracer?._resetTracerForTests()
    tracer = null
  })

  it('redacts the cause the same way the retained-package card does', async () => {
    const { quitAndInstall, getUpdateStatus } = await reachDownloaded()
    const home = os.homedir()
    const escape = String.fromCharCode(27)

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit(
        'error',
        new Error(`${escape}[31mdpkg -i '${home}/.cache/orca-updater/pending/orca.deb'${escape}[0m`)
      )
    })

    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    const status = getUpdateStatus()
    const message = status.state === 'error' ? status.message : ''
    expect(message).not.toContain(home)
    expect(message).not.toContain(escape)
    expect(message).toContain("<home>/.cache/orca-updater/pending/orca.deb'")
  })
})
