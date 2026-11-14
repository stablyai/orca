import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordUsed: vi.fn(),
  details: { enabled: true, popup: 'popup.html' },
  popupWasOpen: false,
  openPopup: vi.fn()
}))

vi.mock('../../../telemetry/browser-extensions-banner', () => ({
  recordBrowserExtensionUsed: mocks.recordUsed
}))
vi.mock('electron', () => ({
  webContents: {
    fromId: () => ({
      id: 7,
      isDestroyed: () => false,
      session: {
        extensions: {
          getExtension: (id: string) => (id === 'known' ? { id: 'known' } : undefined)
        }
      }
    })
  }
}))
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { getGuestWebContentsId: () => 7 }
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: vi.fn(),
  getBrowserExtensionProfileIdForSession: () => 'default'
}))
vi.mock('../permissions/browser-extension-user-gesture', () => ({
  noteBrowserExtensionUserGesture: vi.fn()
}))
vi.mock('../permissions/browser-extension-active-tab', () => ({
  grantBrowserExtensionActiveTab: vi.fn()
}))
vi.mock('./browser-extension-action-registry', () => ({
  getBrowserExtensionActionState: () => ({ get: () => mocks.details }),
  observeBrowserExtensionActionSession: vi.fn(),
  onBrowserExtensionActionsChanged: vi.fn()
}))
vi.mock('./browser-extension-popup-host', () => ({
  consumeBrowserExtensionPopupToggle: () => mocks.popupWasOpen,
  getOpenBrowserExtensionPopup: vi.fn(),
  openBrowserExtensionPopup: mocks.openPopup
}))
vi.mock('../tabs-and-windows/browser-extension-tab-model', () => ({
  describeBrowserExtensionTab: vi.fn(),
  getActiveBrowserTabId: vi.fn(),
  openBrowserExtensionTab: vi.fn(),
  recordActiveBrowserPage: vi.fn(),
  resolveBrowserExtensionTab: () => null
}))
vi.mock('../installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: vi.fn()
}))
vi.mock('./browser-extension-toolbar-pins', () => ({ getPinnedBrowserExtensionIds: vi.fn() }))
vi.mock('../tabs-and-windows/browser-extension-window-model', () => ({
  getBrowserExtensionMainWindow: vi.fn()
}))
vi.mock('./browser-extension-action-icon', () => ({ resolveActionIconDataUrl: vi.fn() }))

import { activateBrowserExtensionAction } from './browser-extension-toolbar'

const anchor = { x: 0, y: 0, width: 24, height: 24 }
function click(overrides: { extensionId?: string; popupOnly?: boolean } = {}) {
  return activateBrowserExtensionAction({
    browserPageId: 'page',
    extensionId: 'known',
    anchor,
    popupOnly: false,
    ...overrides
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.details = { enabled: true, popup: 'popup.html' }
  mocks.popupWasOpen = false
  mocks.openPopup.mockImplementation(() => {})
})

describe('counting a toolbar click as extension use', () => {
  it('counts a click that opens the popup', () => {
    expect(click()).toEqual({ ok: true })
    expect(mocks.recordUsed).toHaveBeenCalledTimes(1)
  })

  it('counts a click delivered to an extension without a popup', () => {
    mocks.details = { enabled: true, popup: '' }
    expect(click()).toEqual({ ok: true })
    expect(mocks.recordUsed).toHaveBeenCalledTimes(1)
  })

  it('does not count a popup the extension opened itself', () => {
    expect(click({ popupOnly: true })).toEqual({ ok: true })
    expect(mocks.openPopup).toHaveBeenCalled()
    expect(mocks.recordUsed).not.toHaveBeenCalled()
  })

  it('does not count the click that closes an open popup', () => {
    mocks.popupWasOpen = true
    expect(click()).toEqual({ ok: true })
    expect(mocks.recordUsed).not.toHaveBeenCalled()
  })

  it('does not count a click on a disabled action', () => {
    mocks.details = { enabled: false, popup: 'popup.html' }
    expect(click()).toEqual({ ok: true })
    expect(mocks.recordUsed).not.toHaveBeenCalled()
  })

  it('does not count a click that fails', () => {
    expect(click({ extensionId: 'missing' })).toMatchObject({ ok: false })
    mocks.openPopup.mockImplementation(() => {
      throw new Error('popup failed')
    })
    expect(click()).toMatchObject({ ok: false })
    expect(mocks.recordUsed).not.toHaveBeenCalled()
  })
})
