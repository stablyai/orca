import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { registerAutoUpdaterHandlers } from './updater-events'
import type { UpdateReleaseHistory, UpdateStatus } from '../../shared/updater/update-status-types'

const {
  appMock,
  nativeUpdaterMock,
  getLinuxPackageTypeMock,
  getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstallMock,
  preExtractUpdateMock
} = vi.hoisted(() => ({
  preExtractUpdateMock: vi.fn(async () => false),
  appMock: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: vi.fn(),
    prependListener: vi.fn()
  },
  nativeUpdaterMock: { on: vi.fn() },
  getLinuxPackageTypeMock: vi.fn<() => 'deb' | 'rpm' | 'non-root' | 'unusable'>(() => 'deb'),
  getLinuxRootPackageTypeMock: vi.fn<() => 'deb' | 'rpm' | null>(() => 'deb'),
  isExternallyManagedLinuxInstallMock: vi.fn<() => boolean>(() => false)
}))

vi.mock('electron', () => ({
  app: appMock,
  autoUpdater: nativeUpdaterMock,
  shell: { showItemInFolder: vi.fn() }
}))

// Use real artifact tracking; fake only package-type detection.
vi.mock('./linux-package/linux-update-package-type', () => ({
  getLinuxPackageType: getLinuxPackageTypeMock,
  getLinuxRootPackageType: getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstall: isExternallyManagedLinuxInstallMock
}))

vi.mock('../cli/appimage/appimage-copy-pre-extraction', () => ({
  preExtractDownloadedAppImageUpdate: preExtractUpdateMock
}))
vi.mock('./releases/updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./releases/updater-release-history', () => ({
  fetchReleaseHistory: vi.fn().mockResolvedValue(null)
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))

const DEB_PATH = '/home/tester/.cache/orca-updater/pending/orca-ide_1.0.61_amd64.deb'
// Capture requires a digest that decodes to exactly 64 bytes.
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
    getCurrentStatus: vi.fn(
      () => ({ state: 'downloading', percent: 42, version: '1.0.61' }) as never
    ),
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
    commitStagedMacInstall: vi.fn(),
    failMacStaging: vi.fn(),
    isAwaitingMacStaging: vi.fn(() => false),
    isMacStagingDeferredToInstall: vi.fn(() => false),
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
    getLinuxPackageTypeMock.mockReset().mockReturnValue('deb')
    getLinuxRootPackageTypeMock.mockReset().mockReturnValue('deb')
    isExternallyManagedLinuxInstallMock.mockReset().mockReturnValue(false)
    appMock.isPackaged = true
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
    const { getTrackedLinuxPackageArtifact } =
      await import('./linux-package/linux-package-update-recovery')
    return {
      context,
      emit: (context.autoUpdater as unknown as ReturnType<typeof createUpdaterStub>).emit,
      getArtifact: getTrackedLinuxPackageArtifact
    }
  }

  it.each([
    ['missing', [{ url: 'orca-ide_1.0.61_amd64.deb' }]],
    ['malformed', [{ url: 'orca-ide_1.0.61_amd64.deb', sha512: 'not-a-digest' }]]
  ])('does not offer recovery when the package digest is %s', async (_kind, files) => {
    const { emit, context, getArtifact } = await register()

    emit('update-downloaded', downloadedEvent({ files }))

    const status = {
      state: 'error',
      message:
        'The downloaded package metadata could not be verified. Quit Orca before downloading and installing the update from the official release page.',
      messageCode: 'linuxPackageMetadataUnusable',
      version: '1.0.61',
      retryable: false
    }
    expect(context.sendStatus).toHaveBeenLastCalledWith(status)
    expect(context.sendStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ recovery: expect.anything() })
    )
    expect(getArtifact()).toBeNull()
  })

  it.each([
    ['idle', { state: 'idle' }],
    ['not-available', { state: 'not-available' }],
    ['check error', { state: 'error', message: 'check failed' }]
  ] as const)(
    'ignores a downloaded event after the target is no longer active (%s)',
    async (_name, status) => {
      const { emit, context, getArtifact } = await register({
        getCurrentStatus: vi.fn(() => status as never),
        getPendingInstallVersion: vi.fn(() => '')
      })

      emit('update-downloaded', downloadedEvent())

      expect(getArtifact()).toBeNull()
      expect(context.sendStatus).not.toHaveBeenCalled()
    }
  )

  it('ignores a downloaded event when the active status and pending target disagree', async () => {
    const { emit, context, getArtifact } = await register({
      getCurrentStatus: vi.fn(
        () => ({ state: 'downloading', percent: 42, version: '1.0.62' }) as never
      ),
      getPendingInstallVersion: vi.fn(() => '1.0.62')
    })

    emit('update-downloaded', downloadedEvent())

    expect(getArtifact()).toBeNull()
    expect(context.sendStatus).not.toHaveBeenCalled()
  })
})

describe('registerAutoUpdaterHandlers release history', () => {
  beforeEach(() => {
    vi.resetModules()
    appMock.getVersion.mockReset().mockReturnValue('1.0.51')
    isExternallyManagedLinuxInstallMock.mockReset().mockReturnValue(false)
  })

  it('shows the update without waiting for release history, then attaches it', async () => {
    const { fetchReleaseHistory } = await import('./releases/updater-release-history')
    let resolveHistory: (history: UpdateReleaseHistory) => void = () => {}
    vi.mocked(fetchReleaseHistory).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve
      })
    )
    let current: UpdateStatus = { state: 'checking' }
    let activeAttemptId: number | null = 1
    const context = createContext({
      getCurrentStatus: vi.fn(() => current),
      getActiveUpdateCheckEventAttemptId: vi.fn(() => activeAttemptId),
      sendStatus: vi.fn((status: UpdateStatus) => {
        current = status
        activeAttemptId = null
      })
    })
    const { registerAutoUpdaterHandlers } = await import('./updater-events')
    registerAutoUpdaterHandlers(context)

    ;(context.autoUpdater as unknown as ReturnType<typeof createUpdaterStub>).emit(
      'update-available',
      { version: '1.0.61' }
    )

    const available = { state: 'available', version: '1.0.61', changelog: null }
    await vi.waitFor(() => expect(context.sendStatus).toHaveBeenCalledWith(available))
    const history: UpdateReleaseHistory = {
      installedVersion: '1.0.51',
      newerReleaseCount: 1,
      releases: [
        { version: '1.0.61', publishedAt: null, notes: 'Notes', releaseUrl: 'https://x/1.0.61' }
      ]
    }
    resolveHistory(history)
    await vi.waitFor(() =>
      expect(context.sendStatus).toHaveBeenLastCalledWith({ ...available, releaseHistory: history })
    )
  })
})
