import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishingIncident } from './updater-prerelease-feed-reproduction.fixture'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

function buildAtomFeed(tags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${tags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')}</feed>`
}

function buildManifest(tag: string): string {
  const version = tag.replace(/^v/i, '')
  return [
    `version: ${version}`,
    'files:',
    `  - url: Orca-${version}-arm64-mac.zip`,
    '    sha512: test',
    `path: Orca-${version}-arm64-mac.zip`
  ].join('\n')
}

function isPlatformManifestRequest(url: string): boolean {
  return /\/latest(?:-[a-z]+)?\.yml$/.test(url)
}

function respondWithAtom(
  tags: string[],
  missingManifestTags: string[] = [],
  missingAssetTags: string[] = [],
  unavailableManifestTags: string[] = [],
  missingManifestStatus = 404
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  const unavailableManifests = new Set(unavailableManifestTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(buildAtomFeed(tags))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[1])
      if (unavailableManifests.has(tag)) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('')
        })
      }
      return Promise.resolve({
        ok: !missingManifests.has(tag),
        status: missingManifests.has(tag) ? missingManifestStatus : 200,
        text: () => Promise.resolve(buildManifest(tag))
      })
    }

    const assetMatch = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
    if (assetMatch && init?.method === 'HEAD') {
      return Promise.resolve({
        ok: !missingAssets.has(decodeURIComponent(assetMatch[1])),
        status: missingAssets.has(decodeURIComponent(assetMatch[1])) ? 404 : 200,
        text: () => Promise.resolve('')
      })
    }

    return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
  })
}

describe('fetchNewerReleaseTagsWithReadiness', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports not-ready with a verified last-good tag when the newest assets are unavailable', async () => {
    respondWithAtom(['v1.4.27', 'v1.4.26'], [], ['v1.4.27'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
  })

  it('does not return a last-good tag whose manifest asset is unavailable', async () => {
    respondWithAtom(['v1.4.27', 'v1.4.26'], [], ['v1.4.27', 'v1.4.26'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'not-ready'
    })
  })

  it('reports no-newer separately from feed fetch failures', async () => {
    respondWithAtom(['v1.4.26'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })

    netFetchMock.mockResolvedValue({ ok: false, text: () => Promise.resolve('') })
    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'feed'
    })
  })

  it('does not classify a non-positive tag limit as feed unavailability', async () => {
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 0)).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reproduces the v1.4.142 publishing incident as not-ready', async () => {
    respondWithAtom(
      publishingIncident.atomTags,
      [publishingIncident.atomStableTag],
      [publishingIncident.atomStableTag],
      [],
      publishingIncident.missingManifestStatus
    )

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    expect(
      await fetchNewerReleaseTagsWithReadiness(publishingIncident.installedVersion, 1, {
        includePrerelease: false
      })
    ).toEqual({
      tags: [],
      state: publishingIncident.expectedState
    })
  })

  it('reports an unavailable newest manifest instead of pinning an older release', async () => {
    respondWithAtom(['v1.4.28', 'v1.4.27'], [], [], ['v1.4.28'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
  })

  it('reports transport failures as unavailable instead of not-ready', async () => {
    netFetchMock.mockImplementation((url: string) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(buildAtomFeed(['v1.4.28']))
        })
      }
      return Promise.reject(new Error('ETIMEDOUT'))
    })

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.27', 1)).resolves.toEqual({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
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

      const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
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

  it('treats an explicit asset 404 as not-ready when another asset is unavailable', async () => {
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(buildAtomFeed(['v1.4.28']))
        })
      }
      if (isPlatformManifestRequest(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              [
                'version: 1.4.28',
                'files:',
                '  - url: orca-windows-setup.exe',
                '    sha512: test',
                '  - url: Orca-1.4.28-mac.zip',
                '    sha512: test'
              ].join('\n')
            )
        })
      }
      if (init?.method === 'HEAD') {
        const isWindowsAsset = url.endsWith('/orca-windows-setup.exe')
        return Promise.resolve({
          ok: false,
          status: isWindowsAsset ? publishingIncident.missingWindowsAssetStatus : 503,
          text: () => Promise.resolve('')
        })
      }
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
    })

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'not-ready'
    })
  })

  it('accepts absolute manifest asset URLs without rewriting them to release asset paths', async () => {
    const assetUrls: string[] = []
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(buildAtomFeed(['v1.4.27']))
        })
      }

      if (isPlatformManifestRequest(url)) {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                'version: 1.4.27',
                'files:',
                '  - url: https://downloads.example.com/Orca-1.4.27-arm64-mac.zip',
                '    sha512: test'
              ].join('\n')
            )
        })
      }

      if (init?.method === 'HEAD') {
        assetUrls.push(url)
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
      }

      return Promise.resolve({ ok: false, text: () => Promise.resolve('') })
    })

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.26')).toBe('v1.4.27')
    expect(assetUrls).toEqual(['https://downloads.example.com/Orca-1.4.27-arm64-mac.zip'])
  })

  it('treats malformed updater manifests as not ready', async () => {
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildAtomFeed(['v1.4.28', 'v1.4.27']))
        })
      }

      if (url.includes('/releases/download/v1.4.28/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('files:\n  - url: [')
        })
      }

      if (url.includes('/releases/download/v1.4.27/') && isPlatformManifestRequest(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(buildManifest('v1.4.27'))
        })
      }

      if (init?.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
      }

      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
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

  it('returns not-ready with an older ready update as last-good while newest is publishing', async () => {
    respondWithAtom(['v1.4.27', 'v1.4.26'], ['v1.4.27'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.25', 1)).resolves.toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
  })

  it('uses prerelease last-good tags only for prerelease-aware checks', async () => {
    respondWithAtom(['v1.4.27-rc.2', 'v1.4.27-rc.1', 'v1.4.26'], ['v1.4.27-rc.2'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.27-rc.1', 1, { includePrerelease: true })
    ).resolves.toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.27-rc.1'
    })
    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.26', 1, { includePrerelease: false })
    ).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })
  })

  it('does not guess a last-good tag outside the bounded probe window', async () => {
    respondWithAtom(
      ['v1.4.33', 'v1.4.32', 'v1.4.31', 'v1.4.30', 'v1.4.29', 'v1.4.28', 'v1.4.27'],
      ['v1.4.33', 'v1.4.32', 'v1.4.31', 'v1.4.30', 'v1.4.29', 'v1.4.28']
    )

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.27', 1)).resolves.toEqual({
      tags: [],
      state: 'not-ready'
    })
  })
})
