import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CatalogModule from './installed-browser-catalog'
import type { DetectedBrowser } from './installed-browser-catalog'

const readBrowsers = vi.hoisted(() => vi.fn<() => Promise<DetectedBrowser[]>>())
vi.mock('./mac-installed-browsers', () => ({ readMacInstalledBrowsers: readBrowsers }))
vi.mock('./windows-installed-browsers', () => ({ readWindowsInstalledBrowsers: readBrowsers }))
vi.mock('./linux-installed-browsers', () => ({ readLinuxInstalledBrowsers: readBrowsers }))

function detected(id: string): DetectedBrowser {
  return { id, name: id, launchCommand: (url) => ({ program: id, args: [url] }) }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** 'pending' when the promise is still waiting, e.g. on a platform scan. */
function settledValue<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20))])
}

async function loadCatalog(): Promise<typeof CatalogModule> {
  vi.resetModules()
  return import('./installed-browser-catalog')
}

beforeEach(() => {
  readBrowsers.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installed browser catalog', () => {
  it('answers from a stale snapshot while a background rescan runs', async () => {
    const catalog = await loadCatalog()
    readBrowsers.mockResolvedValueOnce([detected('chrome')])
    await catalog.listInstalledBrowsers()
    vi.setSystemTime(60_000)
    const rescan = deferred<DetectedBrowser[]>()
    readBrowsers.mockReturnValueOnce(rescan.promise)

    expect(await settledValue(catalog.listInstalledBrowsers())).toEqual([
      { id: 'chrome', name: 'chrome' }
    ])
    expect(readBrowsers).toHaveBeenCalledTimes(2)

    rescan.resolve([detected('chrome'), detected('safari')])
    await vi.waitFor(() =>
      expect(catalog.readInstalledBrowserSnapshot().map(({ id }) => id)).toEqual([
        'chrome',
        'safari'
      ])
    )
  })

  it('rescans for a missing browser id only once the snapshot is stale', async () => {
    const catalog = await loadCatalog()
    readBrowsers.mockResolvedValueOnce([detected('chrome')])

    expect((await catalog.findInstalledBrowser('chrome'))?.id).toBe('chrome')
    expect(await catalog.findInstalledBrowser('safari')).toBeUndefined()
    expect(readBrowsers).toHaveBeenCalledTimes(1)

    vi.setSystemTime(60_000)
    readBrowsers.mockResolvedValueOnce([detected('chrome'), detected('safari')])
    expect((await catalog.findInstalledBrowser('safari'))?.id).toBe('safari')
    expect(await catalog.findInstalledBrowser('firefox')).toBeUndefined()
    expect(readBrowsers).toHaveBeenCalledTimes(2)
  })
})
