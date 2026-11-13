import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import type { BrowserExtensionsBannerAssignment } from '../../shared/browser/extensions/browser-extensions-banner'

const mocks = vi.hoisted(() => {
  const installed: unknown[] = []
  return {
    telemetryEnabled: true,
    track: vi.fn((_name: string, _props: unknown) => true),
    installed
  }
})

vi.mock('./client', () => ({
  isTelemetryEnabled: () => mocks.telemetryEnabled,
  track: mocks.track
}))
vi.mock('../browser/extensions/installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ list: () => mocks.installed })
}))

import {
  assignBrowserExtensionsBanner,
  browserExtensionsBannerForInstall,
  initBrowserExtensionsBanner,
  recordBrowserExtensionUsed
} from './browser-extensions-banner'

const INSTALL_ID = 'install-1'
const BANNER = 'colored_everyday'

type Fake = {
  store: Store
  saved: () => BrowserExtensionsBannerAssignment | undefined
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>
  broadcasts: unknown[]
  ui: { contextualToursSeenIds: string[]; featureInteractions: Record<string, unknown> }
  settings: { browserExtensionsEnabled: boolean; telemetry: Record<string, unknown> }
}

function fakeStore(saved?: BrowserExtensionsBannerAssignment): Fake {
  const telemetry: Record<string, unknown> = {
    installId: INSTALL_ID,
    optedIn: true,
    browserExtensionsBanner: saved
  }
  const settings = { browserExtensionsEnabled: true, telemetry }
  const contextualToursSeenIds: string[] = []
  const ui = { contextualToursSeenIds, featureInteractions: {} }
  const flush = vi.fn(async () => {})
  const broadcasts: unknown[] = []
  const store = {
    getSettings: () => settings,
    getUI: () => ui,
    updateSettings: (
      updates: { telemetry: Record<string, unknown> },
      options?: { notifyListeners?: boolean }
    ) => {
      settings.telemetry = updates.telemetry
      if (options?.notifyListeners) {
        broadcasts.push(updates.telemetry.browserExtensionsBanner)
      }
      return settings
    },
    flushPendingOrThrowAsync: flush
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module reads only these four members.
    store: store as unknown as Store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake stores what the module wrote.
    saved: () => settings.telemetry.browserExtensionsBanner as BrowserExtensionsBannerAssignment,
    flush,
    broadcasts,
    ui,
    settings
  }
}

beforeEach(() => {
  mocks.telemetryEnabled = true
  mocks.installed = []
  mocks.track.mockReset()
  mocks.track.mockReturnValue(true)
})

describe('assignBrowserExtensionsBanner', () => {
  it('picks the same banner for an install every time', () => {
    expect(browserExtensionsBannerForInstall('install-1')).toBe('colored_everyday')
    expect(browserExtensionsBannerForInstall('install-3')).toBe('none')
    expect(browserExtensionsBannerForInstall('install-0')).toBe('plain_bring')
  })

  it('saves durably, reports once, then lets windows follow the banner', async () => {
    mocks.installed = [{}]
    const fake = fakeStore()
    initBrowserExtensionsBanner(fake.store)
    fake.flush.mockImplementation(async () => {
      expect(fake.saved()).toMatchObject({ banner: BANNER, hadExtensions: true })
      expect(fake.saved()?.reported).toBeUndefined()
      expect(mocks.track).not.toHaveBeenCalled()
    })

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'active', banner: BANNER })

    expect(fake.flush).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledWith('browser_extensions_banner_assigned', {
      banner: BANNER,
      had_extensions: true
    })
    expect(fake.broadcasts).toEqual([expect.objectContaining({ banner: BANNER, reported: true })])

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'active', banner: BANNER })
    expect(mocks.track).toHaveBeenCalledTimes(1)
    expect(fake.flush).toHaveBeenCalledTimes(1)
  })

  it('gives windows asking at once one saved record and one event', async () => {
    const fake = fakeStore()
    initBrowserExtensionsBanner(fake.store)

    const replies = await Promise.all([
      assignBrowserExtensionsBanner(),
      assignBrowserExtensionsBanner()
    ])

    expect(replies).toEqual([
      { status: 'active', banner: BANNER },
      { status: 'active', banner: BANNER }
    ])
    expect(fake.flush).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when usage data is off', async () => {
    mocks.telemetryEnabled = false
    const fake = fakeStore()
    initBrowserExtensionsBanner(fake.store)

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'not_enrolled' })

    expect(fake.saved()).toBeUndefined()
    expect(fake.flush).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('answers afresh once the announcement can apply again', async () => {
    const fake = fakeStore()
    fake.ui.contextualToursSeenIds = ['browser-extensions']
    initBrowserExtensionsBanner(fake.store)

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'not_ready' })
    expect(fake.saved()).toBeUndefined()
    expect(mocks.track).not.toHaveBeenCalled()

    fake.ui.contextualToursSeenIds = []
    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'active', banner: BANNER })
  })

  it('holds until the next launch when the save cannot be confirmed', async () => {
    const fake = fakeStore()
    initBrowserExtensionsBanner(fake.store)
    fake.flush.mockRejectedValueOnce(new Error('disk full'))

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'deferred' })
    expect(fake.saved()).toBeUndefined()
    expect(mocks.track).not.toHaveBeenCalled()

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'deferred' })
    expect(fake.flush).toHaveBeenCalledTimes(1)
    expect(mocks.track).not.toHaveBeenCalled()
    expect(fake.broadcasts).toEqual([])
  })

  it('holds a refused report until the next launch, then reports the saved record once', async () => {
    const fake = fakeStore()
    initBrowserExtensionsBanner(fake.store)
    mocks.track.mockReturnValueOnce(false)

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'deferred' })
    const unreported = fake.saved()
    expect(unreported).toMatchObject({ banner: BANNER })
    expect(unreported?.reported).toBeUndefined()
    expect(fake.broadcasts).toEqual([])

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'deferred' })
    expect(mocks.track).toHaveBeenCalledTimes(1)

    // The next launch loads the record from disk.
    const relaunched = fakeStore(unreported)
    initBrowserExtensionsBanner(relaunched.store)
    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'active', banner: BANNER })
    expect(relaunched.flush).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledTimes(2)
    expect(relaunched.saved()).toEqual({ ...unreported, reported: true })
  })
})

describe('recordBrowserExtensionUsed', () => {
  it('reports once per launch', () => {
    initBrowserExtensionsBanner(fakeStore().store)
    recordBrowserExtensionUsed()
    recordBrowserExtensionUsed()
    expect(mocks.track).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledWith('browser_extension_used', {})

    initBrowserExtensionsBanner(fakeStore().store)
    recordBrowserExtensionUsed()
    expect(mocks.track).toHaveBeenCalledTimes(2)
  })
})
