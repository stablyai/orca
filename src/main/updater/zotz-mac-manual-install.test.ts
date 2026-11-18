import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater-service'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'
import type { UpdateStatus } from '../../shared/update-status-types'
import {
  _setZotzMacSelfUpdateForTests,
  hasStableMacSigningIdentity
} from './zotz-mac-manual-install'

const { autoUpdaterMock, fetchNewerReleaseTagsMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () =>
    (await import('./testing/updater-test-harness')).createUpdaterMocks()
  )

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-package/linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./releases/updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./nudges/nudge-campaign', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./releases/updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
// The test host's own node binary may carry a Developer ID; answer as the published ad-hoc build.
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProcess: vi.fn(async () => ({
    code: 0,
    stdout: '',
    stderr: 'Signature=adhoc',
    timedOut: false
  }))
}))

warmUpdaterModule()

const realPlatform = process.platform

describe('Zotz unsigned macOS installs', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    _setZotzMacSelfUpdateForTests(false)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    _setZotzMacSelfUpdateForTests(true)
    vi.useRealTimers()
  })

  async function startUpdater(): Promise<{
    send: ReturnType<typeof vi.fn>
    updater: typeof UpdaterModule
  }> {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.4.25901'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.4.25901' }))
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(updaterMainWindow(send), {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'interactive'
    })
    return { send, updater }
  }

  function lastStatus(send: ReturnType<typeof vi.fn>): UpdateStatus | undefined {
    return send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]
  }

  it('offers the release dmg and never downloads what Squirrel.Mac would reject', async () => {
    const { send, updater } = await startUpdater()
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    expect(lastStatus(send)).toMatchObject({
      state: 'available',
      version: '1.4.25901',
      externallyManaged: true,
      zotzManualDownloadUrl:
        'https://github.com/HugoRodriguezDEV/zotz/releases/download/v1.4.25901/zotz-macos-arm64.dmg'
    })

    updater.downloadUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('hasStableMacSigningIdentity', () => {
  // Real `codesign -dvv` output of the published ad-hoc Zotz 1.4.21401.
  const adHoc = [
    'Executable=/Applications/Zotz.app/Contents/MacOS/Zotz',
    'Identifier=dev.hugorodriguez.zotz',
    'CodeDirectory v=20400 size=463 flags=0x2(adhoc) hashes=9+2 location=embedded',
    'Signature=adhoc',
    'TeamIdentifier=not set'
  ].join('\n')
  const selfSigned = [
    'Executable=/Applications/Zotz.app/Contents/MacOS/Zotz',
    'Identifier=dev.hugorodriguez.zotz',
    'Signature size=1649',
    'Authority=Zotz Release Signing',
    'TeamIdentifier=not set'
  ].join('\n')

  it('lets Squirrel.Mac install only when a certificate pins the identity', () => {
    expect(hasStableMacSigningIdentity(selfSigned, 0)).toBe(true)
    expect(hasStableMacSigningIdentity(adHoc, 0)).toBe(false)
    expect(hasStableMacSigningIdentity('Zotz: code object is not signed at all', 1)).toBe(false)
  })
})
