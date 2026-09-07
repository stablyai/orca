import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from './updater-net-request.fixture'
import { publishingIncident } from './updater-prerelease-feed-reproduction.fixture'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

const { appMock, browserWindowMock, nativeUpdaterMock, autoUpdaterMock, isMock, killAllPtyMock } =
  vi.hoisted(() => {
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
        getVersion: vi.fn(() => '1.0.51'),
        on: appOn,
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
      killAllPtyMock: vi.fn()
    }
  })

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  net: { fetch: netFetchMock, request: netRequestMock }
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

vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

const ONE_HOUR_MS = 60 * 60 * 1000
const THIRTY_SECONDS_MS = 30 * 1000
const FRIENDLY_MESSAGE = "Couldn't reach the update server. Try again in a few minutes."
const RELEASE_NOT_READY_MESSAGE =
  "A newer release isn't available for this device yet. Check again later."
const NOT_READY_DIAGNOSTIC = 'Latest release artifacts are not ready'

type NotReadyProbe = {
  assetStatus?: number
  manifestStatus?: number
  manifestText: string
}

function respondWithNotReadyRelease({
  assetStatus,
  manifestStatus = 200,
  manifestText
}: NotReadyProbe): void {
  const atom = `<feed>${publishingIncident.atomTags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')}</feed>`
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(atom) })
    }
    if (init?.method === 'HEAD' && assetStatus !== undefined) {
      return Promise.resolve({
        ok: assetStatus >= 200 && assetStatus < 300,
        status: assetStatus,
        text: () => Promise.resolve('')
      })
    }
    return Promise.resolve({
      ok: manifestStatus >= 200 && manifestStatus < 300,
      status: manifestStatus,
      text: () => Promise.resolve(manifestText)
    })
  })
}

function makeBenignCheckFailure(message: string): void {
  const error = new Error(message)
  autoUpdaterMock.checkForUpdates.mockImplementation(() => {
    autoUpdaterMock.emit('checking-for-update')
    queueMicrotask(() => {
      autoUpdaterMock.emit('error', error)
    })
    return Promise.reject(error)
  })
}

warmUpdaterModule()

describe('updater check failure handling', () => {
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
    vi.unstubAllGlobals()
    vi.useRealTimers()
    netFetchMock.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<feed></feed>')
    })
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  it('surfaces GitHub release-transition failures with calmer copy and no short retry', async () => {
    vi.useFakeTimers()
    makeBenignCheckFailure('Unable to find latest version on GitHub')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: FRIENDLY_MESSAGE
      })
    )
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Unable to find latest version') })
    )
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('surfaces missing latest-mac.yml to user-initiated checks with calmer copy', async () => {
    makeBenignCheckFailure('Cannot find channel "latest-mac.yml" update info: HttpError: 404')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

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
          message: FRIENDLY_MESSAGE
        })
      )
      expect(statuses).not.toContainEqual(
        expect.objectContaining({ state: 'not-available', userInitiated: true })
      )
    })
  })

  it.each([
    {
      caseName: 'manifest 404',
      manifestStatus: publishingIncident.missingManifestStatus,
      manifestText: ''
    },
    { caseName: 'malformed manifest', manifestText: 'files:\n  - url: [' },
    { caseName: 'empty manifest', manifestText: 'version: 1.4.142\nfiles: []' },
    {
      assetStatus: publishingIncident.missingWindowsAssetStatus,
      caseName: 'asset 404',
      manifestText: 'version: 1.4.142\nfiles:\n  - url: orca-windows-setup.exe'
    }
  ])(
    'maps $caseName into neutral artifact-readiness status and diagnostics',
    async ({ assetStatus, manifestStatus, manifestText }) => {
      appMock.getVersion.mockReturnValue(publishingIncident.installedVersion)
      respondWithNotReadyRelease({ assetStatus, manifestStatus, manifestText })
      const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

      setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
      checkForUpdatesFromMenu()

      await vi.waitFor(() => {
        expect(sendMock).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: RELEASE_NOT_READY_MESSAGE,
          userInitiated: true
        })
      })
      expect(warnMock).toHaveBeenCalledWith('[updater] benign check failure:', NOT_READY_DIAGNOSTIC)
      expect(warnMock.mock.calls.flat().join(' ').toLowerCase()).not.toContain('publishing')
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      warnMock.mockRestore()
    }
  )

  it('silently drops background benign failures to idle and waits for the hourly retry', async () => {
    vi.useFakeTimers()
    makeBenignCheckFailure('Unable to find latest version on GitHub')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdates } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdates()

    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'idle' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS - THIRTY_SECONDS_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('keeps typed not-ready probes idle and schedules the short retry', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue(publishingIncident.installedVersion)
    respondWithNotReadyRelease({
      manifestStatus: publishingIncident.missingManifestStatus,
      manifestText: ''
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdates, getUpdateStatus } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdates()
    await vi.waitFor(() => {
      expect(netFetchMock).toHaveBeenCalledTimes(2)
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(getUpdateStatus()).toEqual({ state: 'idle' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))

    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS)
    expect(netFetchMock).toHaveBeenCalledTimes(4)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('backs off consecutive failing background retries instead of re-checking hourly forever', async () => {
    vi.useFakeTimers()
    makeBenignCheckFailure('Unable to find latest version on GitHub')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdates } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    // First retry keeps the fast 1h cadence for transient release-readiness failures.
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    // Second retry doubles to 2h: nothing at +1h, fires by +2h.
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)

    // Third retry doubles to 4h.
    await vi.advanceTimersByTimeAsync(2 * ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2 * ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(4)

    // A completed check resets the backoff to the fast retry.
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available', { version: '1.0.51' })
      })
      return Promise.resolve(null)
    })
    checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(5)

    makeBenignCheckFailure('Unable to find latest version on GitHub')
    checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(7)
  })
})
