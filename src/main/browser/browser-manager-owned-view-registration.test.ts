import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents, WebContentsView } from 'electron'

const mocks = vi.hoisted(() => ({
  fromId: vi.fn(),
  appGetPath: vi.fn(() => '/downloads'),
  popup: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPath },
  webContents: { fromId: mocks.fromId },
  BrowserWindow: { fromWebContents: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) }
}))
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: mocks.popup }))

import { browserManager } from './browser-manager'
import { resetBrowserManagerState } from './browser-manager-test-harness'
import { DesktopOwnedBrowserViewAdmission } from './desktop-owned-browser-view-admission'

const contentsById = new Map<number, unknown>()

function rig(id = 7, type = 'window', pageId = 'owned-page') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture only compares Session identity; no Session method is called.
  const session = {} as Session
  const shape = {
    id,
    isDestroyed: () => false,
    getType: () => type,
    session,
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements the policy/registration APIs exercised by this suite.
  const guest = shape as unknown as WebContents
  const renderer = {
    id: 8,
    isDestroyed: () => false,
    send: vi.fn(),
    setBackgroundThrottling: vi.fn()
  }
  contentsById.set(id, guest)
  contentsById.set(8, renderer)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration inspects this view's identity and webContents, not native view APIs.
  const view = { webContents: guest } as WebContentsView
  const host = {
    isDestroyed: () => false,
    webContents: renderer,
    contentView: { children: [view] }
  }
  const admission = new DesktopOwnedBrowserViewAdmission({
    isKnownPartition: () => 'persist:fixture',
    getSession: () => session,
    createView: () => view,
    attachPolicies: (contents) => browserManager.attachGuestPolicies(contents)
  })
  const record = admission.create({
    browserPageId: pageId,
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    sessionProfileId: 'profile',
    rendererWebContentsId: 8
  })
  return { guest, shape, renderer, view, host, record }
}

describe('BrowserManager.registerOwnedView', () => {
  beforeEach(() => {
    resetBrowserManagerState()
    contentsById.clear()
    mocks.fromId.mockReset()
    mocks.fromId.mockImplementation((id: number) => contentsById.get(id) ?? null)
  })

  it('accepts only a minted view under its owning renderer and registers normal page routing', () => {
    const fixture = rig()
    expect(browserManager.registerOwnedView(fixture.record, fixture.host)).toBe(true)
    expect(browserManager.getGuestWebContentsId('owned-page')).toBe(7)
    expect(browserManager.isOwnedViewPage('owned-page')).toBe(true)
    browserManager.unregisterGuest('owned-page')
    expect(browserManager.getGuestWebContentsId('owned-page')).toBeNull()
    expect(browserManager.isOwnedViewPage('owned-page')).toBe(false)
  })

  it('rejects copied provenance, a different renderer and missing attachment without altering maps', () => {
    const fixture = rig()
    expect(browserManager.registerOwnedView({ ...fixture.record }, fixture.host)).toBe(false)
    expect(
      browserManager.registerOwnedView(fixture.record, {
        ...fixture.host,
        webContents: { ...fixture.renderer, id: 99 }
      })
    ).toBe(false)
    expect(
      browserManager.registerOwnedView(fixture.record, {
        ...fixture.host,
        contentView: { children: [] }
      })
    ).toBe(false)
    expect(browserManager.getGuestWebContentsId('owned-page')).toBeNull()
  })

  it('cannot replace a registered legacy page with a new owned record', () => {
    const legacy = rig(7, 'webview', 'legacy-page')
    expect(
      browserManager.registerGuest({
        browserPageId: 'legacy-page',
        webContentsId: 7,
        rendererWebContentsId: 8
      })
    ).toBe(true)
    const replacement = rig(9, 'window', 'legacy-page')
    expect(browserManager.registerOwnedView(replacement.record, replacement.host)).toBe(false)
    expect(browserManager.getGuestWebContentsId('legacy-page')).toBe(legacy.guest.id)
  })

  it('does not permit the legacy registration entry to replace an owned page', () => {
    const fixture = rig()
    expect(browserManager.registerOwnedView(fixture.record, fixture.host)).toBe(true)
    rig(9, 'webview', 'replacement')
    expect(
      browserManager.registerGuest({
        browserPageId: 'owned-page',
        webContentsId: 9,
        rendererWebContentsId: 8
      })
    ).toBe(false)
    expect(browserManager.getGuestWebContentsId('owned-page')).toBe(fixture.guest.id)
  })

  it('does not remove live guest listeners when a replacement id is rejected', () => {
    const fixture = rig(7, 'webview', 'legacy-page')
    expect(
      browserManager.registerGuest({
        browserPageId: 'legacy-page',
        webContentsId: 7,
        rendererWebContentsId: 8
      })
    ).toBe(true)
    fixture.shape.off.mockClear()
    expect(
      browserManager.registerGuest({
        browserPageId: 'legacy-page',
        webContentsId: 999,
        rendererWebContentsId: 8
      })
    ).toBe(false)
    expect(fixture.shape.off).not.toHaveBeenCalled()
    expect(browserManager.getGuestWebContentsId('legacy-page')).toBe(7)
  })
})
