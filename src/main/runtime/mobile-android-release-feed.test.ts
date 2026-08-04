import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAndroidReleaseFeedCacheForTests,
  __setAndroidReleaseFeedFetcherForTests,
  extractAndroidVersionCandidates,
  getRecommendedAndroidVersion,
  isAndroidReleaseFeedRefreshPending
} from './mobile-android-release-feed'

afterEach(() => {
  __resetAndroidReleaseFeedCacheForTests()
  vi.restoreAllMocks()
})

describe('extractAndroidVersionCandidates', () => {
  it('sorts exact mobile-android tag refs newest first', () => {
    const versions = extractAndroidVersionCandidates([
      { ref: 'refs/tags/mobile-android-v0.0.30' },
      { ref: 'refs/tags/mobile-android-v0.0.31' },
      { ref: 'refs/tags/mobile-android-v0.0.9' },
      { ref: 'refs/tags/v1.4.150' }, // desktop release — ignored
      { ref: 'refs/tags/mobile-ios-v0.0.31' } // iOS is never sourced here
    ])
    // Why: numeric compare, so 0.0.31 beats 0.0.9 (string compare would invert).
    expect(versions).toEqual(['0.0.31', '0.0.30', '0.0.9'])
  })

  it('rejects non-semver and malformed refs', () => {
    expect(
      extractAndroidVersionCandidates([
        { ref: 'refs/tags/mobile-android-vlatest' },
        { ref: 'refs/tags/mobile-android-v0.0' },
        { ref: 42 },
        {}
      ])
    ).toEqual([])
  })

  it('deduplicates a cold refresh and verifies the published APK', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/git/matching-refs/')
        ? jsonResponse([{ ref: 'refs/tags/mobile-android-v0.0.40' }])
        : jsonResponse({
            tag_name: 'mobile-android-v0.0.40',
            draft: false,
            prerelease: true,
            assets: [{ name: 'app-release.apk' }]
          })
    )
    __setAndroidReleaseFeedFetcherForTests(fetchMock)

    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    expect(isAndroidReleaseFeedRefreshPending()).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()

    await vi.waitFor(() => {
      expect(isAndroidReleaseFeedRefreshPending()).toBe(false)
    })
    expect(getRecommendedAndroidVersion(1_000)).toBe('0.0.40')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back when newer tags lack a confirmed published APK', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/git/matching-refs/')) {
        return jsonResponse([
          { ref: 'refs/tags/mobile-android-v0.0.42' },
          { ref: 'refs/tags/mobile-android-v0.0.41' },
          { ref: 'refs/tags/mobile-android-v0.0.40' }
        ])
      }
      const version = url.match(/mobile-android-v(\d+\.\d+\.\d+)$/)?.[1] ?? ''
      return jsonResponse({
        tag_name: `mobile-android-v${version}`,
        draft: version === '0.0.41' ? 'false' : false,
        assets: version === '0.0.42' ? [] : [{ name: 'app-release.apk' }]
      })
    })
    __setAndroidReleaseFeedFetcherForTests(fetchMock)

    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    await vi.waitFor(() => expect(isAndroidReleaseFeedRefreshPending()).toBe(false))

    expect(getRecommendedAndroidVersion(1_000)).toBe('0.0.40')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('fails open without probing more tags after a provider failure', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/git/matching-refs/')
        ? jsonResponse([
            { ref: 'refs/tags/mobile-android-v0.0.41' },
            { ref: 'refs/tags/mobile-android-v0.0.40' }
          ])
        : jsonResponse({ message: 'rate limited' }, 403)
    )
    __setAndroidReleaseFeedFetcherForTests(fetchMock)

    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    await vi.waitFor(() => expect(isAndroidReleaseFeedRefreshPending()).toBe(false))

    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a cold failure well before the success TTL', async () => {
    let networkUp = false
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/git/matching-refs/')
        ? networkUp
          ? jsonResponse([{ ref: 'refs/tags/mobile-android-v0.0.50' }])
          : jsonResponse({ message: 'offline' }, 503)
        : jsonResponse({
            tag_name: 'mobile-android-v0.0.50',
            draft: false,
            assets: [{ name: 'app-release.apk' }]
          })
    )
    __setAndroidReleaseFeedFetcherForTests(fetchMock)

    // Cold failure: no prior known version, so the host advertises nothing.
    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    await vi.waitFor(() => expect(isAndroidReleaseFeedRefreshPending()).toBe(false))
    expect(fetchMock).toHaveBeenCalledOnce()

    // Still inside the short failure TTL — no retry yet.
    expect(getRecommendedAndroidVersion(9 * 60_000)).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()

    // Past the failure TTL but far inside the 6h success TTL: retry anyway.
    networkUp = true
    expect(getRecommendedAndroidVersion(11 * 60_000)).toBeNull()
    await vi.waitFor(() => expect(isAndroidReleaseFeedRefreshPending()).toBe(false))

    expect(getRecommendedAndroidVersion(11 * 60_000)).toBe('0.0.50')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not re-fetch a successful refresh before the 6h TTL', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/git/matching-refs/')
        ? jsonResponse([{ ref: 'refs/tags/mobile-android-v0.0.51' }])
        : jsonResponse({
            tag_name: 'mobile-android-v0.0.51',
            draft: false,
            assets: [{ name: 'app-release.apk' }]
          })
    )
    __setAndroidReleaseFeedFetcherForTests(fetchMock)

    expect(getRecommendedAndroidVersion(1_000)).toBeNull()
    await vi.waitFor(() => expect(isAndroidReleaseFeedRefreshPending()).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Well past the failure TTL, still inside the success TTL — no refresh.
    expect(getRecommendedAndroidVersion(60 * 60_000)).toBe('0.0.51')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Past 6h: a success does eventually revalidate.
    expect(getRecommendedAndroidVersion(7 * 60 * 60_000)).toBe('0.0.51')
    expect(isAndroidReleaseFeedRefreshPending()).toBe(true)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
