import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { registerAutoUpdaterHandlers } from './updater-events'

const { appMock, nativeUpdaterMock, getLinuxRootPackageTypeMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: vi.fn()
  },
  nativeUpdaterMock: { on: vi.fn() },
  getLinuxRootPackageTypeMock: vi.fn<() => 'deb' | 'rpm' | null>(() => 'deb')
}))

vi.mock('electron', () => ({
  app: appMock,
  autoUpdater: nativeUpdaterMock,
  shell: { showItemInFolder: vi.fn() }
}))

// Why: only the packaged-marker resolver is faked so the real artifact tracking runs.
vi.mock('./linux-update-package-type', () => ({
  getLinuxRootPackageType: getLinuxRootPackageTypeMock
}))

vi.mock('./updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))

const DEB_PATH = '/home/tester/.cache/orca-updater/pending/orca-ide_1.0.61_amd64.deb'
// A real 64-byte SHA-512; capture rejects a digest that cannot decode to one.
const DEB_SHA512 =
  'LHlL7dKoqg98gS2nfQv878dK+UoktbAkm4M20/hoJ2Qr0Kqsa3MSL4VmWy/Lll/MYjQFkpvOxduQ/vswentozA=='

type HandlerContext = Parameters<typeof registerAutoUpdaterHandlers>[0]

function createUpdaterStub(): {
  on: (event: string, handler: (...args: unknown[]) => void) => unknown
  emit: (event: string, ...args: unknown[]) => void
} {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const stub = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return stub
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args)
      }
    }
  }
  return stub
}

function createContext(overrides?: Partial<HandlerContext>): HandlerContext {
  return {
    autoUpdater: createUpdaterStub() as never,
    clearBackgroundCheckLaunchPending: vi.fn(),
    clearAvailableUpdateContext: vi.fn(),
    consumeMissingManifestPrereleaseFallbackResult: vi.fn(() => null),
    getPublishingWindowLastGoodCheck: vi.fn(() => null),
    getMissingManifestPrereleaseFallbackUserInitiated: vi.fn(() => null),
    getCurrentStatus: vi.fn(() => ({ state: 'checking' }) as never),
    getActiveUpdateCheckEventAttemptId: vi.fn(() => 1),
    getKnownReleaseUrl: vi.fn(() => undefined),
    getPendingInstallVersion: vi.fn(() => '1.0.61'),
    getUserInitiatedCheck: vi.fn(() => false),
    handleQuitAndInstallFailure: vi.fn(() => false),
    isQuitAndInstallHandoffActive: vi.fn(() => false),
    hasInstallableDownloadedVersion: vi.fn(() => true),
    isLocalBuildCheck: vi.fn(() => false),
    isPinnedBuildCheck: vi.fn(() => false),
    shouldHandleUpdaterErrorEvent: vi.fn(() => true),
    clearUpdateAvailableEventPending: vi.fn(),
    isActiveUpdateCheckAttempt: vi.fn(() => true),
    markUpdateCheckEventAttempt: vi.fn(() => true),
    markUpdateAvailableEventPending: vi.fn(),
    markMissingManifestPrereleaseFallbackChecking: vi.fn(),
    performQuitAndInstall: vi.fn(),
    shouldDeferMacQuitForInstall: vi.fn(() => true),
    recordCompletedUpdateCheck: vi.fn(),
    restoreReleaseUpdateSource: vi.fn(),
    sendCheckFailureStatus: vi.fn().mockResolvedValue(undefined),
    sendErrorStatus: vi.fn(),
    sendStatus: vi.fn(),
    scheduleAutomaticUpdateCheck: vi.fn(),
    shouldSuppressMissingManifestPrereleaseFallbackEvent: vi.fn(() => false),
    suppressMissingManifestPrereleaseFallbackPromiseFailure: vi.fn(),
    setAvailableReleaseUrl: vi.fn(),
    setAvailableVersion: vi.fn(),
    setUserInitiatedCheck: vi.fn(),
    ...overrides
  }
}

function downloadedEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: '1.0.61',
    downloadedFile: DEB_PATH,
    files: [{ url: 'orca-ide_1.0.61_amd64.deb', sha512: DEB_SHA512 }],
    ...overrides
  }
}

describe('registerAutoUpdaterHandlers linux package artifact tracking', () => {
  beforeEach(() => {
    vi.resetModules()
    appMock.on.mockReset()
    nativeUpdaterMock.on.mockReset()
    appMock.getVersion.mockReset().mockReturnValue('1.0.51')
    getLinuxRootPackageTypeMock.mockReset().mockReturnValue('deb')
  })

  const register = async (
    overrides?: Partial<HandlerContext>
  ): Promise<{
    context: HandlerContext
    emit: (event: string, ...args: unknown[]) => void
    getArtifact: () => unknown
  }> => {
    const context = createContext(overrides)
    const { registerAutoUpdaterHandlers } = await import('./updater-events')
    registerAutoUpdaterHandlers(context)
    const { getTrackedLinuxPackageArtifact } = await import('./linux-package-update-recovery')
    return {
      context,
      emit: (context.autoUpdater as unknown as ReturnType<typeof createUpdaterStub>).emit,
      getArtifact: getTrackedLinuxPackageArtifact
    }
  }

  it('hands the whole downloaded event to artifact capture', async () => {
    const { emit, getArtifact } = await register()

    emit('update-downloaded', downloadedEvent())

    // Why: path and digest exist only in the event's own fields, so a trimmed event fails here.
    expect(getArtifact()).toEqual({
      packageType: 'deb',
      version: '1.0.61',
      path: DEB_PATH,
      sha512: DEB_SHA512
    })
  })

  it('passes the actual updater error into the install-failure handler', async () => {
    const handleQuitAndInstallFailure = vi.fn<(error?: unknown) => boolean>(() => true)
    const { emit, context } = await register({ handleQuitAndInstallFailure })
    const failure = new Error('Command failed, exited with code 127')

    emit('error', failure)

    expect(handleQuitAndInstallFailure).toHaveBeenCalledTimes(1)
    expect(handleQuitAndInstallFailure.mock.calls[0]?.[0]).toBe(failure)
    // Recovery owns the event; no generic check/download error follows it.
    expect(context.sendErrorStatus).not.toHaveBeenCalled()
  })

  it('drops the artifact once the update resolves as not available', async () => {
    const { emit, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    emit('update-not-available')

    expect(getArtifact()).toBeNull()
  })

  it('drops the artifact when another version takes over the cycle', async () => {
    const { emit, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    emit('update-available', { version: '1.0.62' })

    expect(getArtifact()).toBeNull()
  })

  it('drops the artifact when progress reports a different pending version', async () => {
    const { emit, getArtifact } = await register({
      getPendingInstallVersion: vi.fn(() => '1.0.62')
    })
    emit('update-downloaded', downloadedEvent())

    emit('download-progress', { percent: 12 })

    expect(getArtifact()).toBeNull()
  })

  it('keeps the artifact through a same-version recheck', async () => {
    const { emit, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    emit('update-available', { version: '1.0.61' })
    emit('download-progress', { percent: 100 })

    expect(getArtifact()).toEqual(expect.objectContaining({ version: '1.0.61', path: DEB_PATH }))
  })
})
