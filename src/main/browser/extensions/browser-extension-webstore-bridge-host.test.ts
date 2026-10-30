import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../browser-manager', () => ({ browserManager: {} }))
vi.mock('./browser-extension-api-host', () => ({ getBrowserExtensionProfileIdForSession: vi.fn() }))
vi.mock('./browser-extension-install-store', () => ({ getBrowserExtensionInstallStore: vi.fn() }))
vi.mock('./browser-extension-webstore-events', () => ({ toChromeWebStoreExtensionInfo: vi.fn() }))
vi.mock('./browser-extension-webstore-service', () => ({
  chromeWebStoreInstallFlow: {},
  isBrowserExtensionEnabledInProfile: vi.fn()
}))

const { resolveChromeWebStoreFrame } = await import('./browser-extension-webstore-bridge-host')

type StoreEvent = Parameters<typeof resolveChromeWebStoreFrame>[0]

const localSession = {}
const otherSession = {}

function fakeEvent(overrides: {
  url?: string
  type?: string
  isTopFrame?: boolean
  session?: object
  senderId?: number
}) {
  const frame = {
    url:
      overrides.url ??
      'https://chromewebstore.google.com/detail/x/nngceckbapebfimnlniiiahkandclblb',
    parent: overrides.isTopFrame === false ? {} : null,
    frameTreeNodeId: 3,
    isDestroyed: () => false
  }
  const sender = {
    id: overrides.senderId ?? 7,
    session: overrides.session ?? localSession,
    getType: () => overrides.type ?? 'webview',
    isDestroyed: () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members resolveChromeWebStoreFrame reads.
  const event = { sender, senderFrame: frame } as unknown as StoreEvent
  return { frame, event }
}

const lookups = {
  isOrcaBrowserTab: (id: number) => id === 7,
  profileIdForSession: (session: unknown) => (session === localSession ? 'default' : null)
}

describe('resolveChromeWebStoreFrame', () => {
  it('accepts the top frame of an Orca tab on the exact store origin', () => {
    const { event } = fakeEvent({})
    expect(resolveChromeWebStoreFrame(event, lookups)).toMatchObject({
      webContentsId: 7,
      frameTreeNodeId: 3,
      profileId: 'default'
    })
  })

  it.each([
    ['a look-alike host', { url: 'https://chromewebstore.google.com.evil.tld/detail/x' }],
    ['plain http', { url: 'http://chromewebstore.google.com/' }],
    ['another port', { url: 'https://chromewebstore.google.com:444/' }],
    ['a subframe', { isTopFrame: false }],
    ['a non-guest window', { type: 'window' }],
    ['a session that runs no extensions', { session: otherSession }],
    ['a guest Orca does not own as a tab', { senderId: 9 }]
  ])('refuses %s', (_label, overrides) => {
    expect(resolveChromeWebStoreFrame(fakeEvent(overrides).event, lookups)).toBeNull()
  })

  it('stops being valid once the frame leaves the store', () => {
    const { event, frame } = fakeEvent({})
    const resolved = resolveChromeWebStoreFrame(event, lookups)
    expect(resolved?.isStillValid()).toBe(true)
    frame.url = 'https://evil.tld/'
    expect(resolved?.isStillValid()).toBe(false)
  })
})
