import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  buildServeManualUpdateStepsMock,
  fetchNewerReleaseTagsWithReadinessMock,
  getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstallMock,
  recordUpdaterLifecycleMock
} = vi.hoisted(() => ({
  appMock: { isPackaged: true, getVersion: vi.fn(() => '1.4.159') },
  fetchNewerReleaseTagsWithReadinessMock: vi.fn(),
  getLinuxRootPackageTypeMock: vi.fn<() => 'deb' | 'rpm' | null>(() => null),
  isExternallyManagedLinuxInstallMock: vi.fn<() => boolean>(() => false),
  recordUpdaterLifecycleMock: vi.fn(),
  buildServeManualUpdateStepsMock: vi.fn((input: { method: string; latestVersion: string }) => [
    `install ${input.method} ${input.latestVersion}`
  ])
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./linux-update-package-type', () => ({
  getLinuxRootPackageType: getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstall: isExternallyManagedLinuxInstallMock
}))
vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: fetchNewerReleaseTagsWithReadinessMock,
  getReleaseTagUrl: (tag: string) => `https://github.com/stablyai/orca/releases/tag/${tag}`,
  normalizeTagToVersion: (tag: string) => tag.replace(/^v/i, '')
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./serve-manual-update-steps', () => ({
  getServeUpgradeDocUrl: () => 'https://docs.example/upgrade',
  buildServeManualUpdateSteps: buildServeManualUpdateStepsMock
}))

const {
  detectServeUpdateMethod,
  getServeManualUpdateReport,
  SERVE_DISABLE_UPDATE_CHECK_ENV,
  startServeManualUpdateReporting,
  stopServeManualUpdateReporting
} = await import('./serve-manual-update-report')

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('serve manual update report', () => {
  beforeEach(() => {
    appMock.isPackaged = true
    appMock.getVersion.mockReturnValue('1.4.159')
    getLinuxRootPackageTypeMock.mockReset().mockReturnValue(null)
    isExternallyManagedLinuxInstallMock.mockReset().mockReturnValue(false)
    recordUpdaterLifecycleMock.mockReset()
    buildServeManualUpdateStepsMock.mockClear()
    fetchNewerReleaseTagsWithReadinessMock
      .mockReset()
      .mockResolvedValue({ tags: ['v1.4.200'], state: 'ready' })
    setPlatform('linux')
    delete process.env.APPIMAGE
    delete process.env.APPDIR
    delete process.env[SERVE_DISABLE_UPDATE_CHECK_ENV]
  })

  afterEach(() => {
    stopServeManualUpdateReporting()
    setPlatform(originalPlatform)
    delete process.env.APPIMAGE
    delete process.env.APPDIR
    delete process.env[SERVE_DISABLE_UPDATE_CHECK_ENV]
  })

  it('reports nothing until a host starts the contract', () => {
    expect(getServeManualUpdateReport()).toBeNull()
  })

  it('detects the install method from evidence the install carries', () => {
    getLinuxRootPackageTypeMock.mockReturnValue('deb')
    expect(detectServeUpdateMethod()).toBe('deb')

    // Why: the same marker on a host with no matching package manager describes the artifact Orca
    // was built as, not the system that owns the install.
    isExternallyManagedLinuxInstallMock.mockReturnValue(true)
    expect(detectServeUpdateMethod()).toBe('externally-managed')
    isExternallyManagedLinuxInstallMock.mockReturnValue(false)

    getLinuxRootPackageTypeMock.mockReturnValue(null)
    process.env.APPIMAGE = '/opt/orca/orca-linux.AppImage'
    expect(detectServeUpdateMethod()).toBe('appimage')

    delete process.env.APPIMAGE
    process.env.APPDIR = '/opt/orca/squashfs-root'
    expect(detectServeUpdateMethod()).toBe('extracted-appimage')

    delete process.env.APPDIR
    expect(detectServeUpdateMethod()).toBe('unknown')
  })

  it('names the newer version and the exact steps once a check succeeds', async () => {
    getLinuxRootPackageTypeMock.mockReturnValue('deb')

    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    expect(getServeManualUpdateReport()).toEqual({
      method: 'deb',
      check: 'update-available',
      currentVersion: '1.4.159',
      latestVersion: '1.4.200',
      releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.200',
      steps: ['install deb 1.4.200'],
      documentationUrl: 'https://docs.example/upgrade'
    })
  })

  it('logs an available update once per version, not once per check', async () => {
    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })
    stopServeManualUpdateReporting()
    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    const announcements = recordUpdaterLifecycleMock.mock.calls.filter(
      ([event]) => event === 'headless_serve_update_available'
    )
    expect(announcements).toHaveLength(2)
    expect(announcements[0]?.[1]).toMatchObject({
      currentVersion: '1.4.159',
      latestVersion: '1.4.200'
    })
  })

  it('reports `current` with no steps when nothing newer is published', async () => {
    fetchNewerReleaseTagsWithReadinessMock.mockResolvedValue({ tags: [], state: 'no-newer' })

    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    expect(getServeManualUpdateReport()).toMatchObject({
      check: 'current',
      latestVersion: null,
      steps: []
    })
    expect(recordUpdaterLifecycleMock).not.toHaveBeenCalled()
  })

  it.each([
    ['unavailable' as const, { tags: [], state: 'unavailable', unavailableReason: 'feed' }],
    ['not-ready' as const, { tags: ['v1.4.200'], state: 'not-ready' }]
  ])('never advertises a version it could not prove (%s)', async (_label, feedResult) => {
    fetchNewerReleaseTagsWithReadinessMock.mockResolvedValue(feedResult)

    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    expect(getServeManualUpdateReport()).toMatchObject({
      check: 'unavailable',
      latestVersion: null,
      steps: []
    })
  })

  it('reports the method but skips the release check on an unpackaged host', async () => {
    appMock.isPackaged = false

    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    expect(fetchNewerReleaseTagsWithReadinessMock).not.toHaveBeenCalled()
    expect(getServeManualUpdateReport()).toMatchObject({ check: 'unavailable', steps: [] })
  })

  it.each(['interactive', 'supervised-headless-serve'] as const)(
    'makes no network call and publishes nothing on a %s host',
    async (installMode) => {
      await startServeManualUpdateReporting({ installMode, intervalMs: 60_000 })

      expect(fetchNewerReleaseTagsWithReadinessMock).not.toHaveBeenCalled()
      expect(recordUpdaterLifecycleMock).not.toHaveBeenCalled()
      expect(getServeManualUpdateReport()).toBeNull()
    }
  )

  it('makes no outbound call when the operator opts out', async () => {
    process.env[SERVE_DISABLE_UPDATE_CHECK_ENV] = '1'
    getLinuxRootPackageTypeMock.mockReturnValue('deb')

    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    expect(fetchNewerReleaseTagsWithReadinessMock).not.toHaveBeenCalled()
    expect(getServeManualUpdateReport()).toMatchObject({
      method: 'deb',
      check: 'disabled',
      latestVersion: null,
      steps: []
    })
  })

  it('builds the steps once per tag, not once per status poll', async () => {
    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    const first = getServeManualUpdateReport()
    const second = getServeManualUpdateReport()

    expect(buildServeManualUpdateStepsMock).toHaveBeenCalledTimes(1)
    expect(second?.steps).toBe(first?.steps)
  })

  it('follows the running version for the prerelease channel', async () => {
    appMock.getVersion.mockReturnValue('1.4.159-rc.1')

    await startServeManualUpdateReporting({
      installMode: 'unsupported-headless-serve',
      intervalMs: 60_000
    })

    expect(fetchNewerReleaseTagsWithReadinessMock).toHaveBeenCalledWith('1.4.159-rc.1', 1, {
      includePrerelease: true
    })
  })
})
