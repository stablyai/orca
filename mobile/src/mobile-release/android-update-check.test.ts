import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  MAX_RELEASE_PAGES,
  checkForAndroidUpdate,
  fetchLatestAndroidRelease,
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

type Page = { body: unknown; ok?: boolean; next?: string }

function pageResponse(page: Page) {
  return {
    ok: page.ok ?? true,
    status: page.ok === false ? 403 : 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'link' && page.next ? `<${page.next}>; rel="next"` : null
    },
    json: async () => page.body
  }
}

// Why: a request past the last page keeps returning the last page, so cap tests can loop.
function fetchPages(pages: Page[]): typeof fetch {
  let index = 0
  return vi.fn(async () =>
    pageResponse(pages[Math.min(index++, pages.length - 1)])
  ) as unknown as typeof fetch
}

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return fetchPages([{ body, ok }])
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  storage.clear()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null)
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    storage.set(key, value)
  })
})

describe('findLatestAndroidRelease', () => {
  it('picks the highest published mobile-android release that ships an APK', () => {
    const releases = [
      { tag_name: 'v1.4.195', draft: false, assets: [{ name: 'orca-macos-arm64.dmg' }] },
      release('mobile-android-v0.0.46'),
      release('mobile-android-v0.0.10'),
      release('mobile-android-v0.0.9'),
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

  it('derives the APK URL from the tag rather than trusting asset metadata', () => {
    const tampered = {
      ...release('mobile-android-v0.0.47'),
      assets: [{ name: 'app-release.apk', browser_download_url: 'https://evil.example/x.apk' }]
    }
    expect(findLatestAndroidRelease([tampered])?.apkUrl).toBe(
      'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.47/app-release.apk'
    )
  })
})

describe('fetchLatestAndroidRelease', () => {
  const desktopPage = [{ tag_name: 'v1.4.195', draft: false, assets: [] }]
  const next = 'https://api.github.com/repositories/1/releases?per_page=100&page=2'

  it('follows Link pagination until a page contains an Android release', async () => {
    const fetchFn = fetchPages([
      { body: desktopPage, next },
      { body: [release('mobile-android-v0.0.47')] }
    ])
    expect((await fetchLatestAndroidRelease(fetchFn))?.version).toBe('0.0.47')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchFn).mock.calls[1][0]).toBe(next)
  })

  it('stops at the last page when nothing matches', async () => {
    const fetchFn = fetchPages([{ body: desktopPage }])
    expect(await fetchLatestAndroidRelease(fetchFn)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the page cap', async () => {
    const fetchFn = fetchPages([{ body: desktopPage, next }])
    expect(await fetchLatestAndroidRelease(fetchFn)).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(MAX_RELEASE_PAGES)
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

  it('keeps a skip issued while a check is still in flight', async () => {
    const gate = deferred<void>()
    const slow = vi.fn(async () => {
      await gate.promise
      return pageResponse({ body: [release('mobile-android-v0.0.48')] })
    }) as unknown as typeof fetch
    const checking = checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1, fetchFn: slow })
    const skipping = skipAndroidUpdate('0.0.48')
    gate.resolve()
    await Promise.all([checking, skipping])
    expect(
      await checkForAndroidUpdate({ currentVersion: '0.0.47', now: 2, fetchFn: fetchReturning([]) })
    ).toBeNull()
  })

  it('persists a skip immediately even while the release request is still pending', async () => {
    const never = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    void checkForAndroidUpdate({ currentVersion: '0.0.47', now: 1, fetchFn: never })
    await skipAndroidUpdate('0.0.48')
    expect(
      await checkForAndroidUpdate({
        currentVersion: '0.0.47',
        now: 2,
        fetchFn: fetchReturning([release('mobile-android-v0.0.48')])
      })
    ).toBeNull()
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
