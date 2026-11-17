import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from '../testing/updater-net-request.fixture'
import { publishingIncident } from './updater-prerelease-feed-reproduction.fixture'

const ORIGINAL_PLATFORM = process.platform

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock }
}))

function buildAtomFeed(tags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${tags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')}</feed>`
}

function isPlatformManifestRequest(url: string): boolean {
  return /\/latest(?:-[a-z0-9-]+)?\.yml$/.test(url)
}

function setPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

function buildWindowsManifest(version: string): string {
  return [
    `version: ${version}`,
    'files:',
    '  - url: orca-windows-setup.exe',
    '    sha512: test',
    'path: orca-windows-setup.exe'
  ].join('\n')
}

describe('fetchNewerReleaseTagsWithReadiness', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setPlatformForTest(ORIGINAL_PLATFORM)
  })

  it("offers a Windows release from GitHub's asset redirect without probing Azure", async () => {
    setPlatformForTest('win32')
    const assetRequestInits: { method?: string; redirect?: string }[] = []

    netFetchMock.mockImplementation(
      (url: string, init?: { method?: string; redirect?: string }) => {
        if (url === 'https://github.com/stablyai/orca/releases.atom') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(buildAtomFeed(['v1.4.190']))
          })
        }
        if (isPlatformManifestRequest(url)) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(buildWindowsManifest('1.4.190'))
          })
        }
        if (init?.method === 'HEAD') {
          assetRequestInits.push(init)
          return Promise.resolve({ ok: false, status: 302, text: () => Promise.resolve('') })
        }
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
      }
    )

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.189', 1)).resolves.toEqual({
      tags: ['v1.4.190'],
      state: 'ready'
    })
    expect(assetRequestInits).toEqual([expect.objectContaining({ redirect: 'manual' })])
  })

  it('requires every asset referenced by the manifest files list to be reachable', async () => {
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(buildAtomFeed(['v1.4.28', 'v1.4.27']))
        })
      }

      const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
      if (manifestMatch) {
        const version = decodeURIComponent(manifestMatch[1]).replace(/^v/i, '')
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              [
                `version: ${version}`,
                'files:',
                '  - url: orca-windows-setup.exe',
                '    sha512: test',
                `  - url: Orca-${version}-mac.zip`,
                '    sha512: test',
                `path: Orca-${version}-mac.zip`
              ].join('\n')
            )
        })
      }

      if (init?.method === 'HEAD') {
        const latest = url.includes('/v1.4.28/')
        const unavailable = latest && url.endsWith('/Orca-1.4.28-mac.zip')
        const missing = latest && url.endsWith('/orca-windows-setup.exe')
        return Promise.resolve({
          ok: !missing && !unavailable,
          status: missing ? publishingIncident.missingWindowsAssetStatus : unavailable ? 503 : 200,
          text: () => Promise.resolve('')
        })
      }

      return Promise.resolve({ ok: false, text: () => Promise.resolve('') })
    })

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.26')).toBeNull()
    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.27'
    })
  })
})
