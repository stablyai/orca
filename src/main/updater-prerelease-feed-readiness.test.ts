import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

type AtomFeedEntry = string | { tag: string; updated?: string }

const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z'

function getAtomFeedEntryTag(entry: AtomFeedEntry): string {
  return typeof entry === 'string' ? entry : entry.tag
}

function buildAtomFeed(entries: AtomFeedEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries
    .map((entry) => {
      const tag = getAtomFeedEntryTag(entry)
      const updated = typeof entry === 'string' ? OLD_UPDATED_AT : entry.updated
      return [
        '<entry>',
        `<link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/>`,
        `<title>${tag}</title>`,
        updated === undefined ? '' : `<updated>${updated}</updated>`,
        '</entry>'
      ].join('')
    })
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
  tags: AtomFeedEntry[],
  missingManifestTags: string[] = [],
  missingAssetTags: string[] = []
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(buildAtomFeed(tags)) })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[1])
      return Promise.resolve({
        ok: !missingManifests.has(tag),
        text: () => Promise.resolve(buildManifest(tag))
      })
    }

    const assetMatch = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
    if (assetMatch && init?.method === 'HEAD') {
      return Promise.resolve({
        ok: !missingAssets.has(decodeURIComponent(assetMatch[1])),
        text: () => Promise.resolve('')
      })
    }

    return Promise.resolve({ ok: false, text: () => Promise.resolve('') })
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
      state: 'unavailable'
    })
  })

  it('requires every asset referenced by the manifest files list to be reachable', async () => {
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildAtomFeed(['v1.4.28', 'v1.4.27']))
        })
      }

      const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
      if (manifestMatch) {
        const version = decodeURIComponent(manifestMatch[1]).replace(/^v/i, '')
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                `version: ${version}`,
                'files:',
                `  - url: Orca-${version}-mac.zip`,
                '    sha512: test',
                `  - url: Orca-${version}-arm64-mac.zip`,
                '    sha512: test',
                `path: Orca-${version}-mac.zip`
              ].join('\n')
            )
        })
      }

      if (init?.method === 'HEAD') {
        return Promise.resolve({
          ok: !url.endsWith('/Orca-1.4.28-arm64-mac.zip'),
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

  it('accepts absolute manifest asset URLs without rewriting them to release asset paths', async () => {
    const assetUrls: string[] = []
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
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
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') })
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
        return Promise.resolve({ ok: true, text: () => Promise.resolve('files:\n  - url: [') })
      }

      if (url.includes('/releases/download/v1.4.27/') && isPlatformManifestRequest(url)) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(buildManifest('v1.4.27')) })
      }

      if (init?.method === 'HEAD') {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') })
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

  it('reports cooldown when every newer stable release is too fresh', async () => {
    respondWithAtom([{ tag: 'v1.4.28', updated: '2026-06-28T00:00:00.000Z' }])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.27', 1, {
        includePrerelease: false,
        minReleaseAgeMs: 3 * 24 * 60 * 60 * 1000,
        nowMs: Date.parse('2026-06-29T00:00:00.000Z')
      })
    ).resolves.toEqual({
      tags: [],
      state: 'cooldown'
    })
  })

  it('returns an older newer release when the newest release is inside the cooldown', async () => {
    respondWithAtom([
      { tag: 'v1.4.27', updated: '2026-06-28T00:00:00.000Z' },
      { tag: 'v1.4.26', updated: '2026-06-20T00:00:00.000Z' }
    ])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.25', 1, {
        includePrerelease: false,
        minReleaseAgeMs: 3 * 24 * 60 * 60 * 1000,
        nowMs: Date.parse('2026-06-29T00:00:00.000Z')
      })
    ).resolves.toEqual({
      tags: ['v1.4.26'],
      state: 'ready'
    })
  })

  it('returns the newest newer release when all newer releases are aged', async () => {
    respondWithAtom([
      { tag: 'v1.4.27', updated: '2026-06-20T00:00:00.000Z' },
      { tag: 'v1.4.26', updated: '2026-06-19T00:00:00.000Z' }
    ])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.25', 1, {
        includePrerelease: false,
        minReleaseAgeMs: 3 * 24 * 60 * 60 * 1000,
        nowMs: Date.parse('2026-06-29T00:00:00.000Z')
      })
    ).resolves.toEqual({
      tags: ['v1.4.27'],
      state: 'ready'
    })
  })

  it('keeps existing behavior when no minimum release age is configured', async () => {
    respondWithAtom([{ tag: 'v1.4.27', updated: '2026-06-28T00:00:00.000Z' }])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.26', 1, {
        includePrerelease: false,
        nowMs: Date.parse('2026-06-29T00:00:00.000Z')
      })
    ).resolves.toEqual({
      tags: ['v1.4.27'],
      state: 'ready'
    })
  })

  it('excludes newer candidates with missing updated timestamps while cooldown is active', async () => {
    respondWithAtom([{ tag: 'v1.4.27' }])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.26', 1, {
        includePrerelease: false,
        minReleaseAgeMs: 3 * 24 * 60 * 60 * 1000,
        nowMs: Date.parse('2026-06-29T00:00:00.000Z')
      })
    ).resolves.toEqual({
      tags: [],
      state: 'cooldown'
    })
  })
})
