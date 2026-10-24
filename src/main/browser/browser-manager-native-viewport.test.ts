import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({
  contents: new Map<number, WebContents>(),
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPathMock },
  BrowserWindow: { fromWebContents: mocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: mocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: mocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: mocks.screenGetCursorScreenPointMock },
  webContents: { fromId: (id: number) => mocks.contents.get(id) ?? null }
}))
vi.mock('../window/desktop-renderer-registry', () => ({
  desktopWindowId: (renderer: { id: number }) => `native-${renderer.id}`
}))
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))
vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({ mode: 'clean', userAgent: GUEST_CLEAN_UA })
}))
import { BrowserManager } from './browser-manager'
import {
  createViewportGuestFactory,
  GUEST_CLEAN_UA
} from './browser-manager-viewport-test-fixtures'
import { DestroyedGuestTestContents } from './browser-manager-destroyed-guest-test-fixture'
import type { BrowserAnnotationViewportBridgeOptions } from '../../shared/browser-annotation-viewport-bridge'

const manager = new BrowserManager()
const makeGuest = createViewportGuestFactory(mocks)
const mobile = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
const desktop = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }

function register(id: number, rendererId: number) {
  const handle = makeGuest(id)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing viewport fixture supplies the WebContents methods used by registration and CDP identity.
  const guest = handle.guest as unknown as WebContents
  mocks.contents.set(id, guest)
  mocks.contents.set(rendererId, new DestroyedGuestTestContents(rendererId).asWebContents())
  manager.attachGuestPolicies(guest)
  expect(
    manager.registerGuest({
      browserPageId: 'shared',
      webContentsId: id,
      rendererWebContentsId: rendererId
    })
  ).toBe(true)
  return handle
}

afterEach(() => {
  manager.unregisterAll()
  mocks.contents.clear()
})

describe('native peer viewport operations', () => {
  it('keeps A queued annotation geometry while B reports and injects its own geometry', async () => {
    const a = register(101, 501)
    const b = register(102, 502)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const inject = vi
      .fn()
      .mockImplementationOnce(() => {
        entered.resolve()
        return gate.promise
      })
      .mockResolvedValue(true)
    a.guest.executeJavaScriptInIsolatedWorld = inject
    const options: BrowserAnnotationViewportBridgeOptions = {
      enabled: true,
      emitViewport: false,
      markers: [],
      token: 'nativeannotationtoken'
    }
    const resolveA = () => manager.getAuthorizedGuest('shared', 501)
    const first = manager.setAnnotationViewportBridge('shared', options, resolveA)
    await entered.promise
    const queued = manager.setAnnotationViewportBridge(
      'shared',
      { ...options, token: 'freshnativeannotation' },
      resolveA
    )
    manager.selectNativeRenderer(502)
    manager.setViewportScrollState('shared', 502, {
      scrollLeft: 0,
      scrollTop: 0,
      maxScrollLeft: 10,
      maxScrollTop: 10
    })
    await expect(
      manager.setAnnotationViewportBridge('shared', options, () =>
        manager.getAuthorizedGuest('shared', 502)
      )
    ).resolves.toBe(true)
    gate.resolve()
    expect(await Promise.all([first, queued])).toEqual([true, true])
    expect(inject).toHaveBeenCalledTimes(2)
    expect(b.guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
    expect(manager.getGuestWebContentsId('shared')).toBe(102)
  })

  it.each(['Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled'])(
    'finishes A identity while B reports scroll during %s',
    async (method) => {
      const a = register(101, 501)
      const b = register(102, 502)
      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      a.debuggerSendCommand.mockImplementation((command) => {
        if (command === method) {
          entered.resolve()
          return gate.promise
        }
        return Promise.resolve()
      })
      manager.selectNativeRenderer(501)
      const pending = manager.setViewportOverride('shared', mobile)
      await entered.promise
      manager.selectNativeRenderer(502)
      manager.setViewportScrollState('shared', 502, {
        scrollLeft: 0,
        scrollTop: 5,
        maxScrollLeft: 50,
        maxScrollTop: 100
      })
      const peerApplied = await manager.setViewportOverride('shared', desktop)
      gate.resolve()
      expect(peerApplied).toBe(true)
      await expect(pending).resolves.toBe(true)
      expect(a.standingUserAgentOverride()).toMatchObject({
        userAgent: expect.stringContaining('iPhone'),
        userAgentMetadata: { mobile: true }
      })
      expect(b.presentedUserAgent()).not.toContain('iPhone')
      expect(manager.getGuestWebContentsId('shared')).toBe(102)
    }
  )
})
