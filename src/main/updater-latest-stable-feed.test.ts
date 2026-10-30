import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from './updater-net-request.fixture'

const originalPlatform = process.platform
const originalArch = process.arch
const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))
vi.mock('electron', () => ({ net: { fetch: netFetchMock, request: netRequestMock } }))

const latestUrl = 'https://github.com/stablyai/orca/releases/latest'
const releaseUrl = 'https://github.com/stablyai/orca/releases/download/v1.4.241'

function serveLatestRelease(location = '/stablyai/orca/releases/tag/v1.4.241'): void {
  netFetchMock.mockImplementation(async (url: string) => {
    if (url === latestUrl) {
      return new Response(null, { status: 302, headers: { location } })
    }
    if (url.endsWith('.yml')) {
      return new Response(
        'version: 1.4.241\nfiles:\n  - url: Orca-1.4.241-arm64-mac.zip\n    sha512: test\n'
      )
    }
    return new Response(null, { status: 200 })
  })
}

describe('latest stable release fallback', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    Object.defineProperty(process, 'arch', { value: originalArch })
  })

  it.each([
    { platform: 'darwin', arch: 'arm64', manifest: 'latest-mac.yml' },
    { platform: 'win32', arch: 'x64', manifest: 'latest.yml' },
    { platform: 'linux', arch: 'x64', manifest: 'latest-linux.yml' },
    { platform: 'linux', arch: 'arm64', manifest: 'latest-linux-arm64.yml' }
  ])(
    'probes the concrete $platform/$arch release before returning its tag',
    async ({ platform, arch, manifest }) => {
      Object.defineProperty(process, 'platform', { value: platform })
      Object.defineProperty(process, 'arch', { value: arch })
      serveLatestRelease()
      const { fetchLatestStableReleaseTag } = await import('./updater-prerelease-feed')

      await expect(fetchLatestStableReleaseTag()).resolves.toBe('v1.4.241')
      expect(netFetchMock).toHaveBeenCalledWith(
        latestUrl,
        expect.objectContaining({ method: 'HEAD', redirect: 'manual' })
      )
      expect(netFetchMock).toHaveBeenCalledWith(`${releaseUrl}/${manifest}`, expect.anything())
      expect(netFetchMock).toHaveBeenCalledWith(
        `${releaseUrl}/Orca-1.4.241-arm64-mac.zip`,
        expect.objectContaining({ method: 'HEAD' })
      )
    }
  )

  it.each([
    'https://other.example/stablyai/orca/releases/tag/v1.4.241',
    '/other/repo/releases/tag/v1.4.241',
    '/stablyai/orca/releases/tag/v1.4.242-rc.1',
    '/stablyai/orca/releases/tag/mobile-android-v0.0.59',
    '/stablyai/orca/releases/tag/%',
    '/stablyai/orca/releases/latest'
  ])('rejects an invalid fallback redirect %s before probing assets', async (location) => {
    serveLatestRelease(location)
    const { fetchLatestStableReleaseTag } = await import('./updater-prerelease-feed')

    await expect(fetchLatestStableReleaseTag()).resolves.toBeNull()
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['manifest', 'installer'])('rejects a release with a missing %s', async (missing) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    serveLatestRelease()
    const respond = netFetchMock.getMockImplementation()
    netFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(missing === 'manifest' ? '.yml' : '.zip')) {
        return new Response(null, { status: 404 })
      }
      return respond?.(url)
    })
    const { fetchLatestStableReleaseTag } = await import('./updater-prerelease-feed')

    await expect(fetchLatestStableReleaseTag()).resolves.toBeNull()
  })

  it('keeps a network failure retryable instead of returning a moving URL', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network unavailable'))
    const { fetchLatestStableReleaseTag } = await import('./updater-prerelease-feed')
    await expect(fetchLatestStableReleaseTag()).resolves.toBeNull()

    serveLatestRelease('https://github.com/stablyai/orca/releases/tag/v1.4.241')
    await expect(fetchLatestStableReleaseTag()).resolves.toBe('v1.4.241')
  })
})
