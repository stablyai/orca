import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from '../testing/updater-net-request.fixture'

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock }
}))

vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: () => Promise.resolve(null),
  rejectReleaseApiToken: vi.fn()
}))

function respondWithReleasesApi(...pages: { tag: string; publishedAt: string }[][]): void {
  const atomImplementation = netFetchMock.getMockImplementation()
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.startsWith('https://api.github.com/repos/stablyai/orca/releases')) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      const payload = (pages[page - 1] ?? []).map(({ tag, publishedAt }) => ({
        tag_name: tag,
        published_at: publishedAt,
        assets: ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].map((name) => ({ name }))
      }))
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(payload)
      })
    }
    return atomImplementation?.(url, init)
  })
}

function buildAtomFeed(tags: string[], updatedAt: Record<string, string> = {}): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry>${updatedAt[tag] ? `<updated>${updatedAt[tag]}</updated>` : ''}<link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
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

function respondWithAtom(
  tags: string[],
  missingManifestTags: string[] = [],
  missingAssetTags: string[] = [],
  unavailableManifestTags: string[] = [],
  updatedAt: Record<string, string> = {}
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  const unavailableManifests = new Set(unavailableManifestTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(buildAtomFeed(tags, updatedAt))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
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
        status: missingManifests.has(tag) ? 404 : 200,
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

    return Promise.resolve({
      ok: false,
      text: () => Promise.resolve('')
    })
  })
}

describe('fetchNewerReleaseTagsWithReadiness update delay', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-11-02T12:00:00Z')
  const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()
  const delay = { includePrerelease: false, minReleaseAgeMs: 7 * DAY_MS, now: NOW }

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  it('offers the newest release past the delay and reports the newer one it holds', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(8),
      'v1.4.1': daysAgo(20)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual(['v1.4.2'])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.3',
      version: '1.4.3',
      releasedAt: NOW - DAY_MS
    })
  })

  it('offers an aged-out release despite a recent older-line release in the Atom feed', async () => {
    const atomTags = ['v1.4.266', 'v1.4.265', 'v1.3.99']
    const publishedAt: Record<string, string> = {
      'v1.4.266': daysAgo(0),
      'v1.4.265': daysAgo(1),
      'v1.3.99': daysAgo(1)
    }
    respondWithAtom(atomTags, [], [], [], publishedAt)
    respondWithReleasesApi([
      ...atomTags.map((tag) => ({ tag, publishedAt: publishedAt[tag] })),
      { tag: 'v1.4.250', publishedAt: daysAgo(8) },
      { tag: 'v1.4.249', publishedAt: daysAgo(9) }
    ])
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.248', 1, delay)
    expect(result.tags).toEqual(['v1.4.250'])
    expect(result.releaseDelay?.heldRelease?.tag).toBe('v1.4.266')
  })

  it('keeps paging when only REST, not the Atom feed, dates a release past the delay', async () => {
    respondWithAtom(['v1.4.276', 'v1.4.257'], [], [], [], {
      'v1.4.276': daysAgo(0),
      'v1.4.257': daysAgo(1)
    })
    const youngReleases = Array.from({ length: 19 }, (_, index) => ({
      tag: `v1.4.${276 - index}`,
      publishedAt: daysAgo(0)
    }))
    respondWithReleasesApi(
      [...youngReleases, { tag: 'v1.4.257', publishedAt: daysAgo(8) }],
      [
        { tag: 'v1.4.250', publishedAt: daysAgo(9) },
        { tag: 'v1.4.249', publishedAt: daysAgo(10) }
      ]
    )
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.248', 1, delay)
    expect(result.tags).toEqual(['v1.4.250'])
  })

  it('fails closed for releases without a feed timestamp', async () => {
    respondWithAtom(['v1.4.2'])
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual([])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.2',
      version: '1.4.2',
      releasedAt: null
    })
  })
})
