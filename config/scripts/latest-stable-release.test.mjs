import { describe, expect, it, vi } from 'vitest'
import {
  fetchReleases,
  latestStableDesktopReleaseTag,
  parseDesktopStableTag
} from './latest-stable-release.mjs'

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

describe('parseDesktopStableTag', () => {
  it('accepts only desktop stable tags', () => {
    expect(parseDesktopStableTag('v1.4.44')).toMatchObject({
      tag: 'v1.4.44',
      major: 1,
      minor: 4,
      patch: 44
    })
    expect(parseDesktopStableTag('v1.4.44-rc.0')).toBeNull()
    expect(parseDesktopStableTag('mobile-v0.0.12')).toBeNull()
    expect(parseDesktopStableTag('cli-v4.12.28')).toBeNull()
  })
})

describe('latestStableDesktopReleaseTag', () => {
  it('chooses the highest stable semver instead of release list order', () => {
    const releases = [
      { tag_name: 'v1.4.43-rc.0', draft: false },
      { tag_name: 'v1.4.42', draft: false },
      { tag_name: 'v1.4.44', draft: false },
      { tag_name: 'mobile-v0.0.12', draft: false }
    ]

    expect(latestStableDesktopReleaseTag(releases)).toBe('v1.4.44')
  })

  it('ignores draft stable releases', () => {
    const releases = [
      { tag_name: 'v1.4.45', draft: true },
      { tag_name: 'v1.4.44', draft: false }
    ]

    expect(latestStableDesktopReleaseTag(releases)).toBe('v1.4.44')
  })

  it('returns empty when no published stable desktop release exists', () => {
    expect(
      latestStableDesktopReleaseTag([
        { tag_name: 'v1.4.44-rc.0', draft: false },
        { tag_name: 'mobile-v0.0.12', draft: false }
      ])
    ).toBe('')
  })
})

describe('fetchReleases', () => {
  it('fetches all release pages', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `v1.0.${index}`,
      draft: false
    }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([{ tag_name: 'v1.4.44', draft: false }]))

    const releases = await fetchReleases('stablyai/orca', 'token', fetchImpl)

    expect(releases).toHaveLength(101)
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/stablyai/orca/releases?per_page=100&page=1',
      expect.any(Object)
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/stablyai/orca/releases?per_page=100&page=2',
      expect.any(Object)
    )
  })
})
