import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TracerModule from './observability/tracer'
import type * as UpdaterModule from './updater'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  isMock,
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
      quit: vi.fn(),
      exit: vi.fn()
    },
    browserWindowMock: { getAllWindows: vi.fn(() => []) },
    nativeUpdaterMock: { on: vi.fn() },
    autoUpdaterMock,
    isMock: { dev: false },
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
vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))
vi.mock('@electron-toolkit/utils', () => ({ is: isMock }))
vi.mock('./ipc/pty', () => ({ killAllPty: killAllPtyMock }))
vi.mock('./updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))
vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./linux-update-package-type', () => ({
  getLinuxPackageType: () => 'non-root',
  getLinuxRootPackageType: () => null,
  isExternallyManagedLinuxInstall: () => false
}))

// The real electron-updater DebUpdater failure text when elevation is impossible.
const DEB_ELEVATION_ERROR =
  'Error: Command failed: /usr/bin/pkexec --disable-internal-agent "/bin/bash" "-c" "dpkg -i \'/home/u/.cache/orca-updater/pending/orca-ide_1.4.163_amd64.deb\'"\npkexec must be setuid root'

// electron-updater's ERR_UPDATER_INVALID_SIGNATURE text, which drives its own card in UpdateCard.
const WINDOWS_SIGNATURE_MISMATCH_ERROR =
  'New version 1.4.163 is not signed by the application owner: publisherNames: Orca, Inc.'

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

function installSpan(): CapturedSpan | undefined {
  return spans.find((span) => span.name === 'updater.install')
}

/** Drives the updater to `downloaded`, the only state `quitAndInstall` acts on. */
async function reachDownloaded(): Promise<typeof UpdaterModule> {
  const mainWindow = { webContents: { send: vi.fn() } }
  autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
  // Why: resetModules gives each test a fresh module graph, so the sink must be installed on the
  // same tracer instance updater.ts will import.
  tracer = await import('./observability/tracer')
  tracer.setActiveSink(capturingSink())
  const updater = await loadUpdaterModule()

  updater.setupAutoUpdater(mainWindow as never)
  await vi.waitFor(() => {
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })
  autoUpdaterMock.emit('checking-for-update')
  autoUpdaterMock.emit('update-available', { version: '1.4.163' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  autoUpdaterMock.downloadUpdate.mockResolvedValue([])
  updater.downloadUpdate()
  autoUpdaterMock.emit('update-downloaded', { version: '1.4.163' })
  expect(updater.getUpdateStatus().state).toBe('downloaded')
  return updater
}

warmUpdaterModule()

/**
 * On a `.deb` Linux host electron-updater's `install()` catches the failed elevation and
 * re-dispatches it through the 'error' event *synchronously* inside `quitAndInstall()`. Orca
 * recovers the app state, so the payload has to survive on the status and the span has to exit
 * Failure — otherwise the only record of why the install never ran is destroyed (#11906).
 */
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
    isMock.dev = false
    killAllPtyMock.mockReset()
    recordUpdaterLifecycleMock.mockReset()
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true
    })
    vi.useRealTimers()
    spans = []
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    })
    tracer?._resetTracerForTests()
    tracer = null
  })

  it('reports the underlying elevation failure rather than a generic restart message', async () => {
    const { quitAndInstall, getUpdateStatus } = await reachDownloaded()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error(DEB_ELEVATION_ERROR))
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    const status = getUpdateStatus()
    expect(status.state).toBe('error')
    // The only place the real cause exists is this event payload; dropping it leaves nothing
    // in the logs and nothing actionable in the client's remote-server update dialog.
    const message = status.state === 'error' ? status.message : ''
    expect(message).toContain('pkexec')
    expect(message).toContain('Could not start the update installer.')
  })

  it('keeps the durable breadcrumb to classification only', async () => {
    const { quitAndInstall } = await reachDownloaded()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error(DEB_ELEVATION_ERROR))
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'quit_and_install_failed_via_event',
      { errorType: 'Error' },
      expect.anything()
    )
  })

  it('exits the install span Failure with the cause', async () => {
    const { quitAndInstall } = await reachDownloaded()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error(DEB_ELEVATION_ERROR))
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(installSpan()).toBeDefined()
    })

    expect(installSpan()?.exit._tag).toBe('Failure')
    expect(installSpan()?.exit.cause).toContain('pkexec')
  })

  it('exits the install span Success when the installer takes over', async () => {
    const { quitAndInstall } = await reachDownloaded()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      // The installer runs and the old process is left to exit; no 'error' comes back.
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(installSpan()).toBeDefined()
    })

    expect(installSpan()?.exit._tag).toBe('Success')
  })

  it('keeps a Windows signature verdict unprefixed so its own card still renders', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    const { quitAndInstall, getUpdateStatus } = await reachDownloaded()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error(WINDOWS_SIGNATURE_MISMATCH_ERROR))
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    const status = getUpdateStatus()
    // Prefixing this would put two contradictory instructions on one card.
    expect(status.state === 'error' ? status.message : '').toBe(WINDOWS_SIGNATURE_MISMATCH_ERROR)
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
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    const status = getUpdateStatus()
    const message = status.state === 'error' ? status.message : ''
    expect(message).not.toContain(home)
    expect(message).not.toContain(escape)
    expect(message).toContain("<home>/.cache/orca-updater/pending/orca.deb'")
  })

  it('carries the cause when quitAndInstall throws instead of dispatching an error event', async () => {
    const { quitAndInstall, getUpdateStatus } = await reachDownloaded()

    // Squirrel/NSIS can reject the request by throwing out of the native call; the event path never runs.
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      throw new Error('Squirrel.framework is missing from the app bundle')
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(getUpdateStatus().state).toBe('error')
    })

    const status = getUpdateStatus()
    const message = status.state === 'error' ? status.message : ''
    expect(message).toContain('Squirrel.framework is missing from the app bundle')
    expect(message).toContain('Could not start the update installer.')
  })
})
