import { describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  fetchLatestAndroidRelease,
  parseAndroidReleaseTag,
  selectLatestAndroidRelease
} from './android-release-feed'

function ref(tag: string) {
  return { ref: `refs/tags/${tag}` }
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body }
}

describe('parseAndroidReleaseTag', () => {
  it('accepts the release workflow tag shape, bare or as a ref', () => {
    expect(parseAndroidReleaseTag('mobile-android-v0.0.36')).toBe('0.0.36')
    expect(parseAndroidReleaseTag('refs/tags/mobile-android-v0.0.36')).toBe('0.0.36')
  })

  it('ignores other release trains and malformed versions', () => {
    expect(parseAndroidReleaseTag('refs/tags/mobile-ios-v0.0.36')).toBeNull()
    expect(parseAndroidReleaseTag('refs/tags/v1.4.162')).toBeNull()
    expect(parseAndroidReleaseTag('mobile-android-v0.0')).toBeNull()
    expect(parseAndroidReleaseTag('mobile-android-v1.2.3-beta')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by numeric component, not string', () => {
    expect(compareVersions('0.0.36', '0.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.0.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.0.36', '0.0.36')).toBe(0)
    expect(compareVersions('0.0.35', '0.0.36')).toBeLessThan(0)
  })
})

describe('selectLatestAndroidRelease', () => {
  // Why: refs arrive oldest-first, so ordering must come from the parsed
  // version rather than the position in the response.
  it('picks the highest android version regardless of list order', () => {
    const latest = selectLatestAndroidRelease([
      ref('mobile-android-v0.0.9'),
      ref('mobile-android-v0.0.36'),
      ref('mobile-android-v0.0.12'),
      ref('mobile-ios-v9.9.9')
    ])

    expect(latest).toEqual({
      version: '0.0.36',
      tag: 'mobile-android-v0.0.36',
      url: 'https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.36'
    })
  })

  it('returns null for an empty list or an error object', () => {
    expect(selectLatestAndroidRelease([])).toBeNull()
    expect(selectLatestAndroidRelease([ref('mobile-ios-v1.0.0')])).toBeNull()
    expect(selectLatestAndroidRelease({ message: 'rate limited' })).toBeNull()
  })
})

describe('fetchLatestAndroidRelease', () => {
  it('returns the newest release from a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([ref('mobile-android-v0.0.37')]))

    await expect(
      fetchLatestAndroidRelease({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual({
      version: '0.0.37',
      tag: 'mobile-android-v0.0.37',
      url: 'https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.37'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  // Why: refs are oldest-first, so a full page means the newest tag is further on.
  it('follows pages until a short page proves it saw the newest tag', async () => {
    const firstPage = Array.from({ length: 100 }, (_unused, index) =>
      ref(`mobile-android-v0.0.${index}`)
    )
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(firstPage))
      .mockResolvedValueOnce(okResponse([ref('mobile-android-v0.1.4')]))

    await expect(
      fetchLatestAndroidRelease({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toMatchObject({ version: '0.1.4' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stays silent on rate limits, network errors and junk bodies', async () => {
    const rateLimited = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const offline = vi.fn().mockRejectedValue(new Error('Network request failed'))
    const junk = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token')
      }
    })

    for (const fetchImpl of [rateLimited, offline, junk]) {
      await expect(
        fetchLatestAndroidRelease({ fetchImpl: fetchImpl as unknown as typeof fetch })
      ).resolves.toBeNull()
    }
  })

  it('gives up rather than hanging when the request stalls', async () => {
    const stalling = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
        })
    )

    await expect(
      fetchLatestAndroidRelease({ fetchImpl: stalling as unknown as typeof fetch, timeoutMs: 5 })
    ).resolves.toBeNull()
  })
})
