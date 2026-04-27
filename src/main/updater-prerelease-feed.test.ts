import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function respondWithAtom(tags: string[]): void {
  netFetchMock.mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(buildAtomFeed(tags))
  })
}

describe('fetchNewerReleaseTag', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
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
})
