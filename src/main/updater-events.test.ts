import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../shared/update-status-types'
import type { registerAutoUpdaterHandlers } from './updater-events'

const {
  appMock,
  nativeUpdaterMock,
  getLinuxPackageTypeMock,
  getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstallMock
} = vi.hoisted(() => ({
  appMock: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: vi.fn()
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

// Why: only the packaged-marker resolver is faked so the real artifact tracking runs.
vi.mock('./linux-update-package-type', () => ({
  getLinuxPackageType: getLinuxPackageTypeMock,
  getLinuxRootPackageType: getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstall: isExternallyManagedLinuxInstallMock
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

  it.each(['deb', 'rpm'] as const)(
    'publishes manual-install recovery after a %s download',
    async (packageType) => {
      getLinuxPackageTypeMock.mockReturnValue(packageType)
      getLinuxRootPackageTypeMock.mockReturnValue(packageType)
      const { emit, context } = await register()
      const fileName = packageType === 'deb' ? 'orca.deb' : 'orca.rpm'

      emit(
        'update-downloaded',
        downloadedEvent({
          downloadedFile: `/home/tester/.cache/orca-updater/pending/${fileName}`,
          files: [{ url: fileName, sha512: DEB_SHA512 }]
        })
      )

      expect(context.sendStatus).toHaveBeenLastCalledWith({
        state: 'error',
        message: 'Quit Orca before running the system package install command.',
        recovery: {
          kind: 'linux-package-install',
          packageType,
          reason: 'manual-install-required',
          version: '1.0.61'
        }
      })
    }
  )

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
      version: '1.0.61',
      retryable: false
    }
    expect(context.sendStatus).toHaveBeenLastCalledWith(status)
    expect(context.sendStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ recovery: expect.anything() })
    )
    expect(getArtifact()).toBeNull()
  })

  it('publishes the normal downloaded state for AppImage builds', async () => {
    getLinuxPackageTypeMock.mockReturnValue('non-root')
    getLinuxRootPackageTypeMock.mockReturnValue(null)
    const { emit, context } = await register()

    emit('update-downloaded', downloadedEvent())
    if (process.platform === 'darwin') {
      const handler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      handler?.()
    }

    expect(context.sendStatus).toHaveBeenLastCalledWith({
      state: 'downloaded',
      version: '1.0.61',
      releaseUrl: undefined
    })
  })

  it('blocks downloaded-state handling when the packaged marker is unusable', async () => {
    getLinuxPackageTypeMock.mockReturnValue('unusable')
    getLinuxRootPackageTypeMock.mockReturnValue(null)
    const { emit, context, getArtifact } = await register()

    emit('update-downloaded', downloadedEvent())

    expect(context.sendStatus).toHaveBeenLastCalledWith({
      state: 'error',
      message:
        'Orca could not verify the installed Linux package format, so it will not install this update automatically. Download the update from the official release page and install it manually.',
      version: '1.0.61',
      retryable: false
    })
    expect(getArtifact()).toBeNull()
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

  it('keeps manual-install recovery when a later check finds no newer release', async () => {
    const { emit, context, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    // Why: the download already produced this exact status, so the assertion below could pass
    // on that call alone. Clear it so only the second emit can satisfy it.
    vi.mocked(context.sendStatus).mockClear()

    emit('update-not-available')

    expect(getArtifact()).toEqual(expect.objectContaining({ version: '1.0.61' }))
    expect(context.sendStatus).toHaveBeenLastCalledWith({
      state: 'error',
      message: 'Quit Orca before running the system package install command.',
      recovery: {
        kind: 'linux-package-install',
        packageType: 'deb',
        reason: 'manual-install-required',
        version: '1.0.61'
      }
    })
  })

  it('keeps manual-install recovery when a later check finds only the installed release', async () => {
    const { emit, context, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    // Why: the download already produced this exact status, so the assertion below could pass
    // on that call alone. Clear it so only the second emit can satisfy it.
    vi.mocked(context.sendStatus).mockClear()

    emit('update-available', { version: '1.0.51' })

    expect(getArtifact()).toEqual(expect.objectContaining({ version: '1.0.61' }))
    expect(context.sendStatus).toHaveBeenLastCalledWith({
      state: 'error',
      message: 'Quit Orca before running the system package install command.',
      recovery: {
        kind: 'linux-package-install',
        packageType: 'deb',
        reason: 'manual-install-required',
        version: '1.0.61'
      }
    })
  })

  it('clears recovery when a newer update takes over before no-update settles', async () => {
    const { emit, context, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    emit('update-available', { version: '1.0.62' })
    emit('update-not-available')

    expect(getArtifact()).toBeNull()
    expect(context.sendStatus).toHaveBeenLastCalledWith({
      state: 'not-available',
      userInitiated: undefined
    })
  })

  it('drops the artifact when another version takes over the cycle', async () => {
    const { emit, getArtifact } = await register()
    emit('update-downloaded', downloadedEvent())

    emit('update-available', { version: '1.0.62' })

    expect(getArtifact()).toBeNull()
  })

  it('ignores a downloaded event for an older target', async () => {
    const { emit, context, getArtifact } = await register({
      getCurrentStatus: vi.fn(() => ({ state: 'available', version: '1.0.62' }) as never),
      getPendingInstallVersion: vi.fn(() => '1.0.62')
    })

    emit('update-downloaded', downloadedEvent())

    expect(getArtifact()).toBeNull()
    expect(context.sendStatus).not.toHaveBeenCalled()
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

  it('accepts a matching event when the pending cache target was cleared', async () => {
    const { emit, context, getArtifact } = await register({
      getCurrentStatus: vi.fn(
        () => ({ state: 'downloading', percent: 42, version: '1.0.61' }) as never
      ),
      getPendingInstallVersion: vi.fn(() => '')
    })

    emit('update-downloaded', downloadedEvent())

    expect(getArtifact()).toEqual(expect.objectContaining({ version: '1.0.61' }))
    expect(context.sendStatus).toHaveBeenLastCalledWith({
      state: 'error',
      message: 'Quit Orca before running the system package install command.',
      recovery: {
        kind: 'linux-package-install',
        packageType: 'deb',
        reason: 'manual-install-required',
        version: '1.0.61'
      }
    })
  })

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

  it('drops the artifact when progress reports a different pending version', async () => {
    const { emit, getArtifact } = await register({
      getPendingInstallVersion: vi.fn(() => '1.0.62')
    })
    emit('update-downloaded', downloadedEvent())

    emit('download-progress', { percent: 12 })

    expect(getArtifact()).toBeNull()
  })

  // #17702: the externallyManaged flag is spread onto the fallback object only, so a retained
  // manual-install status must still win. Cross-version case: the host could self-update when it
  // downloaded, and cannot now.
  it.each([false, true])(
    'keeps manual-install recovery through a same-version recheck (externallyManaged=%s)',
    async (externallyManaged) => {
      isExternallyManagedLinuxInstallMock.mockReturnValue(externallyManaged)
      let status: UpdateStatus = { state: 'downloading', percent: 100, version: '1.0.61' }
      const { emit, context, getArtifact } = await register({
        getCurrentStatus: vi.fn(() => status)
      })
      emit('update-downloaded', downloadedEvent())

      // Why: the download already emitted the manual-install status, so waitFor would pass on that
      // call alone. Clear it so the assertion can only be satisfied by the recheck.
      vi.mocked(context.sendStatus).mockClear()
      status = { state: 'checking' }
      emit('update-available', { version: '1.0.61' })

      expect(getArtifact()).toEqual(expect.objectContaining({ version: '1.0.61', path: DEB_PATH }))
      await vi.waitFor(() =>
        expect(context.sendStatus).toHaveBeenLastCalledWith({
          state: 'error',
          message: 'Quit Orca before running the system package install command.',
          recovery: {
            kind: 'linux-package-install',
            packageType: 'deb',
            reason: 'manual-install-required',
            version: '1.0.61'
          }
        })
      )
    }
  )
})
