import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_PLATFORM = process.platform

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

function buildAtomFeed(tags: string[]): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
}

function respondWithAtom(tags: string[], missingManifestTags: string[] = []): void {
  const missingManifests = new Set(missingManifestTags)
  netFetchMock.mockImplementation((url: string) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(buildAtomFeed(tags))
      })
    }

    const match = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
    if (!match) {
      return Promise.resolve({ ok: false, text: () => Promise.resolve('') })
    }

    return Promise.resolve({
      ok: !missingManifests.has(decodeURIComponent(match[1])),
      text: () => Promise.resolve('')
    })
  })
}

function setPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('fetchNewerReleaseTag', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
  })

  afterEach(() => {
    setPlatformForTest(ORIGINAL_PLATFORM)
  })

  it('returns the newest stable tag when the user is on an RC and a newer stable exists', async () => {
    respondWithAtom(['v1.3.19', 'v1.3.19-rc.6', 'v1.3.19-rc.4', 'v1.3.18'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe('v1.3.19')
  })

  it('returns the newest RC tag when no stable is newer than the current RC', async () => {
    respondWithAtom(['v1.3.19-rc.6', 'v1.3.19-rc.4', 'v1.3.18'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.4')).toBe('v1.3.19-rc.6')
  })

  it('can exclude prerelease tags for stable-channel checks', async () => {
    respondWithAtom(['v1.4.1-rc.0', 'v1.4.0', 'v1.3.52-rc.3', 'v1.3.51'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.51', { includePrerelease: false })).toBe('v1.4.0')
  })

  it.each([
    ['darwin', 'latest-mac.yml'],
    ['linux', 'latest-linux.yml'],
    ['win32', 'latest.yml']
  ] satisfies [NodeJS.Platform, string][])(
    'probes the %s platform manifest',
    async (platform, manifestName) => {
      setPlatformForTest(platform)
      const manifestUrls: string[] = []

      netFetchMock.mockImplementation((url: string) => {
        if (url === 'https://github.com/stablyai/orca/releases.atom') {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(buildAtomFeed(['v1.4.1']))
          })
        }

        manifestUrls.push(url)
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('')
        })
      })

      const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

      expect(await fetchNewerReleaseTag('1.4.0')).toBe('v1.4.1')
      expect(manifestUrls).toEqual([
        `https://github.com/stablyai/orca/releases/download/v1.4.1/${manifestName}`
      ])
    }
  )

  it('returns null for stable-channel checks when only prereleases are newer', async () => {
    respondWithAtom(['v1.4.1-rc.0', 'v1.3.52-rc.3', 'v1.3.51'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.51', { includePrerelease: false })).toBe(null)
  })

  it('returns null when nothing in the feed is newer than the current version', async () => {
    respondWithAtom(['v1.3.18', 'v1.3.17'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe(null)
  })

  it('ignores entries with unparseable tags', async () => {
    respondWithAtom(['not-a-version', 'v1.3.20', 'garbage'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe('v1.3.20')
  })

  it('returns null when the fetch is not ok', async () => {
    netFetchMock.mockResolvedValue({ ok: false, text: () => Promise.resolve('') })
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe(null)
  })

  it('returns null when the fetch throws', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'))
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe(null)
  })

  it('picks semver-newest across a mixed-order feed', async () => {
    // atom feed sort by publish time, not version — verify we pick by semver
    respondWithAtom(['v1.2.0', 'v1.3.19', 'v1.3.19-rc.6', 'v1.3.20-rc.1', 'v1.3.18'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe('v1.3.20-rc.1')
  })

  it('returns a bounded fallback candidate after the newest newer tag', async () => {
    respondWithAtom(['v1.3.51-rc.7', 'v1.3.51-rc.6', 'v1.3.51-rc.5'])
    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTags('1.3.51-rc.6', 2)).toEqual(['v1.3.51-rc.7', 'v1.3.51-rc.6'])
  })

  it('skips feed tags whose platform updater manifest is missing', async () => {
    respondWithAtom(
      ['v1.4.1-rc.4', 'v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'],
      ['v1.4.1-rc.4', 'v1.4.1-rc.3']
    )

    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTags('1.4.1-rc.1', 2)).toEqual(['v1.4.1-rc.2', 'v1.4.1-rc.1'])
  })

  it('does not return the current tag as the primary update when newer manifests are missing', async () => {
    respondWithAtom(['v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'], ['v1.4.1-rc.3', 'v1.4.1-rc.2'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTags } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTags('1.4.1-rc.1', 2)).toEqual([])
  })

  it('probes a bounded manifest window concurrently', async () => {
    const feedTags = [
      'v1.4.8-rc.0',
      'v1.4.7-rc.0',
      'v1.4.6-rc.0',
      'v1.4.5-rc.0',
      'v1.4.4-rc.0',
      'v1.4.3-rc.0',
      'v1.4.2-rc.0',
      'v1.4.1-rc.0'
    ]
    const manifestUrls: string[] = []
    const manifestResolvers: (() => void)[] = []

    netFetchMock.mockImplementation((url: string) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildAtomFeed(feedTags))
        })
      }

      manifestUrls.push(url)
      return new Promise((resolve) => {
        manifestResolvers.push(() => {
          resolve({ ok: false, text: () => Promise.resolve('') })
        })
      })
    })

    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')
    const result = fetchNewerReleaseTags('1.4.0-rc.0', 2)

    await vi.waitFor(() => {
      expect(manifestUrls).toHaveLength(6)
    })
    expect(manifestResolvers).toHaveLength(6)

    for (const resolveManifest of manifestResolvers) {
      resolveManifest()
    }

    await expect(result).resolves.toEqual([])
    expect(netFetchMock).toHaveBeenCalledTimes(7)
  })
})
