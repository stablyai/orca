import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  checkForAndroidUpdate,
  compareVersions,
  findLatestAndroidRelease,
  skipAndroidUpdate
} from './android-update-check'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

const storage = new Map<string, string>()

function release(tag: string, opts: { draft?: boolean; apk?: boolean } = {}) {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    assets:
      opts.apk === false
        ? []
        : [
            {
              name: 'app-release.apk',
              browser_download_url: `https://github.com/stablyai/orca/releases/download/${tag}/app-release.apk`
            }
          ]
  }
}

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch
}

beforeEach(() => {
  storage.clear()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null)
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    storage.set(key, value)
  })
})

describe('compareVersions', () => {
  it('compares dotted versions numerically, not lexically', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.0.47', '0.0.47')).toBe(0)
    expect(compareVersions('0.1.0', '0.0.99')).toBeGreaterThan(0)
  })
})

describe('findLatestAndroidRelease', () => {
  it('picks the highest published mobile-android release that ships an APK', () => {
    const releases = [
      { tag_name: 'v1.4.195', draft: false, assets: [{ name: 'orca-macos-arm64.dmg' }] },
      release('mobile-android-v0.0.46'),
      release('mobile-android-v0.0.49', { draft: true }),
      release('mobile-android-v0.0.48', { apk: false }),
      release('mobile-android-v0.0.47')
    ]
    expect(findLatestAndroidRelease(releases)).toEqual({
      version: '0.0.47',
      apkUrl:
        'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.47/app-release.apk'
    })
  })

  it('returns null for malformed or empty payloads', () => {
    expect(findLatestAndroidRelease(null)).toBeNull()
    expect(findLatestAndroidRelease({ message: 'rate limited' })).toBeNull()
    expect(findLatestAndroidRelease([{ tag_name: 42 }])).toBeNull()
  })
})

describe('checkForAndroidUpdate', () => {
  it('fetches on first run and reports a newer release', async () => {
    const fetchFn = fetchReturning([release('mobile-android-v0.0.48')])
    const update = await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1000, fetchFn })
    expect(update).toEqual({
      version: '0.0.48',
      apkUrl:
        'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.48/app-release.apk'
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reuses the stored result inside the check interval instead of refetching', async () => {
    const first = fetchReturning([release('mobile-android-v0.0.48')])
    await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1000, fetchFn: first })
    const second = fetchReturning([release('mobile-android-v0.0.50')])
    const update = await checkForAndroidUpdate({
      currentVersion: '0.0.47',
      now: 1000 + CHECK_INTERVAL_MS - 1,
      fetchFn: second
    })
    expect(update?.version).toBe('0.0.48')
    expect(second).not.toHaveBeenCalled()
  })

  it('refetches once the interval has elapsed', async () => {
    await checkForAndroidUpdate({
      currentVersion: '0.0.47',
      now: 1000,
      fetchFn: fetchReturning([release('mobile-android-v0.0.48')])
    })
    const later = fetchReturning([release('mobile-android-v0.0.50')])
    const update = await checkForAndroidUpdate({
      currentVersion: '0.0.47',
      now: 1000 + CHECK_INTERVAL_MS,
      fetchFn: later
    })
    expect(update?.version).toBe('0.0.50')
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('returns null when the installed version is current or newer', async () => {
    const fetchFn = fetchReturning([release('mobile-android-v0.0.47')])
    expect(await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1, fetchFn })).toBeNull()
    expect(await checkForAndroidUpdate({ currentVersion: '0.0.48', now: 1, fetchFn })).toBeNull()
  })

  it('hides a version the user skipped, but surfaces the next one', async () => {
    await skipAndroidUpdate('0.0.48')
    expect(
      await checkForAndroidUpdate({
        currentVersion: '0.0.47',
        now: 1,
        fetchFn: fetchReturning([release('mobile-android-v0.0.48')])
      })
    ).toBeNull()
    expect(
      await checkForAndroidUpdate({
        currentVersion: '0.0.47',
        now: 1 + CHECK_INTERVAL_MS,
        fetchFn: fetchReturning([release('mobile-android-v0.0.49')])
      })
    ).toEqual(expect.objectContaining({ version: '0.0.49' }))
  })

  it('does not persist a failed check, so the next run retries', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(
      await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1, fetchFn: failing })
    ).toBeNull()
    const ok = fetchReturning([release('mobile-android-v0.0.48')])
    expect(
      (await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 2, fetchFn: ok }))?.version
    ).toBe('0.0.48')
  })

  it('treats a non-2xx response as a failed check', async () => {
    const rateLimited = fetchReturning({ message: 'API rate limit exceeded' }, false)
    expect(
      await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1, fetchFn: rateLimited })
    ).toBeNull()
    const ok = fetchReturning([release('mobile-android-v0.0.48')])
    expect(
      (await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 2, fetchFn: ok }))?.version
    ).toBe('0.0.48')
  })
})
