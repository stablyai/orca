import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
  openPopupWithOriginBarMock: vi.fn(),
  processUserAgentMode: 'clean',
  processUserAgent: ''
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPathMock },
  BrowserWindow: { fromWebContents: mocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: mocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: mocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: mocks.screenGetCursorScreenPointMock },
  webContents: { fromId: mocks.webContentsFromIdMock }
}))
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: mocks.openPopupWithOriginBarMock
}))

vi.mock('../../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: mocks.processUserAgentMode,
    userAgent: mocks.processUserAgent,
    electronUserAgent:
      mocks.processUserAgentMode === 'native'
        ? mocks.processUserAgent
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
  })
}))

import { browserManager } from '../browser-manager'
import { resetBrowserManagerMocks, resetBrowserManagerState } from '../browser-manager-test-harness'
import {
  createViewportGuestFactory,
  GUEST_CLEAN_UA
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const mobile = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
const desktop = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
const guests = new Map<number, Record<string, unknown>>()
const registeredGuests = readViewportStateMap('webContentsIdByTabId')
const presetIntents = readViewportStateMap('viewportPresetByTabId')
const pendingOperations = readViewportStateMap('viewportOpsByTabId')
const cdpUserAgentOverrides = readViewportStateMap('cdpUserAgentOverrideStateByGuestId')

function readViewportStateMap(
  name:
    | 'webContentsIdByTabId'
    | 'viewportPresetByTabId'
    | 'viewportOpsByTabId'
    | 'cdpUserAgentOverrideStateByGuestId'
): Map<unknown, unknown> {
  const value: unknown = browserManager[name]
  if (!(value instanceof Map)) {
    throw new Error(`Expected manager state map: ${name}`)
  }
  return value
}

function register(tab: string, id: number) {
  const handle = makeGuest(id)
  guests.set(id, handle.guest)
  expect(
    browserManager.registerOffscreenGuest({
      browserPageId: tab,
      webContentsId: id
    })
  ).toBe(true)
  return handle
}

function pause(handle: ReturnType<typeof makeGuest>, method: string) {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let blocked = false
  handle.debuggerSendCommand.mockImplementation((next) => {
    if (!blocked && next === method) {
      blocked = true
      entered.resolve()
      return gate.promise
    }
    return Promise.resolve()
  })
  return { entered: entered.promise, ...gate }
}

describe('browser viewport operation ownership', () => {
  beforeEach(() => {
    expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    resetBrowserManagerMocks(mocks)
    resetBrowserManagerState()
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    guests.clear()
    mocks.webContentsFromIdMock.mockImplementation((id) => guests.get(id))
  })
  afterEach(() => {
    browserManager.unregisterAll()
    vi.restoreAllMocks()
  })

  it('does not recreate closed-tab UA intent after a late touch completion', async () => {
    const handle = register('closed', 100)
    const gate = pause(handle, 'Emulation.setTouchEmulationEnabled')
    const result = browserManager.setViewportOverride('closed', mobile)
    await gate.entered
    browserManager.unregisterGuest('closed')
    expect(presetIntents.size).toBe(0)
    const isDestroyed = handle.guest.isDestroyed
    expect(vi.isMockFunction(isDestroyed)).toBe(true)
    if (vi.isMockFunction(isDestroyed)) {
      isDestroyed.mockReturnValue(true)
    }
    gate.resolve()
    await expect(result).resolves.toBe(false)
    expect(registeredGuests.size).toBe(0)
    expect(presetIntents.size).toBe(0)
    expect(cdpUserAgentOverrides.size).toBe(0)
  })

  it('preserves replacement desktop intent after an old clear fails', async () => {
    const handle = register('replacement', 102)
    await browserManager.setViewportOverride('replacement', mobile)
    const gate = pause(handle, 'Emulation.setUserAgentOverride')
    const result = browserManager.setViewportOverride('replacement', null)
    await gate.entered
    browserManager.unregisterGuest('replacement')
    register('replacement', 103)
    await expect(browserManager.setViewportOverride('replacement', desktop)).resolves.toBe(true)
    gate.reject(new Error('Old target closed'))
    await expect(result).resolves.toBe(false)
    expect(registeredGuests.get('replacement')).toBe(103)
    expect(presetIntents.get('replacement')).toEqual({
      guestWebContentsId: 103,
      requested: desktop,
      applied: desktop
    })
  })

  // Requested and applied metrics may clear while the separate UA override remains tracked.
  it('same-owner clear failure keeps the standing mobile override tracked', async () => {
    const handle = register('same-owner', 106)
    await browserManager.setViewportOverride('same-owner', mobile)
    const gate = pause(handle, 'Emulation.setUserAgentOverride')
    const result = browserManager.setViewportOverride('same-owner', null)
    await gate.entered
    gate.reject(new Error('Protocol error'))
    await expect(result).resolves.toBe(false)
    expect(presetIntents.get('same-owner')).toEqual({
      guestWebContentsId: 106,
      requested: null,
      applied: null
    })
    expect(handle.presentedUserAgent()).toContain('iPhone')
    expect(cdpUserAgentOverrides.has(106)).toBe(true)
  })

  it('old queued operations cannot remove or join a replacement promise tail', async () => {
    const old = register('queued-replacement', 114)
    const oldGate = pause(old, 'Emulation.setTouchEmulationEnabled')
    const first = browserManager.setViewportOverride('queued-replacement', mobile)
    const second = browserManager.setViewportOverride('queued-replacement', null)
    await oldGate.entered
    browserManager.unregisterGuest('queued-replacement')
    const replacement = register('queued-replacement', 115)
    const newGate = pause(replacement, 'Emulation.setTouchEmulationEnabled')
    const replacementFirst = browserManager.setViewportOverride('queued-replacement', desktop)
    const replacementSecond = browserManager.setViewportOverride('queued-replacement', mobile)
    await newGate.entered
    const tail = pendingOperations.get('queued-replacement')
    oldGate.resolve()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(pendingOperations.get('queued-replacement')).toBe(tail)
    newGate.resolve()
    await expect(replacementFirst).resolves.toBe(true)
    await expect(replacementSecond).resolves.toBe(true)
    expect(pendingOperations.size).toBe(0)
    expect(presetIntents.get('queued-replacement')).toEqual({
      guestWebContentsId: 115,
      requested: mobile,
      applied: mobile
    })
    expect(replacement.presentedUserAgent()).toContain('iPhone')
  })

  it('normal same-owner toggles preserve last-requested order and remove the promise tail', async () => {
    const handle = register('serialized', 116)
    const gate = pause(handle, 'Emulation.setTouchEmulationEnabled')
    const first = browserManager.setViewportOverride('serialized', mobile)
    await gate.entered
    const second = browserManager.setViewportOverride('serialized', desktop)
    const third = browserManager.setViewportOverride('serialized', null)
    gate.resolve()
    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    // Clear mobile identity when desktop metrics replace the mobile viewport.
    expect(handle.debuggerSendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled'
    ])
    expect(handle.presentedUserAgent()).toBe(GUEST_CLEAN_UA)
    expect(pendingOperations.size).toBe(0)
    expect(presetIntents.get('serialized')).toEqual({
      guestWebContentsId: 116,
      requested: null,
      applied: null
    })
  })
})
