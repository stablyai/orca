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
vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: mocks.openPopupWithOriginBarMock
}))

vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: mocks.processUserAgentMode,
    userAgent: mocks.processUserAgent
  })
}))

import { browserManager } from './browser-manager'
import { resetBrowserManagerMocks, resetBrowserManagerState } from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  GUEST_CLEAN_UA,
  GUEST_ELECTRON_UA
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const mobile = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
const desktop = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
const guests = new Map<number, Record<string, unknown>>()
const registeredGuests = readViewportStateMap('webContentsIdByTabId')
const uaIntents = readViewportStateMap('viewportUaOverrideMobileByTabId')
const presetIntents = readViewportStateMap('viewportPresetActiveByTabId')
const pendingOperations = readViewportStateMap('viewportOpsByTabId')

function readViewportStateMap(
  name:
    | 'webContentsIdByTabId'
    | 'viewportUaOverrideMobileByTabId'
    | 'viewportPresetActiveByTabId'
    | 'viewportOpsByTabId'
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
    expect(uaIntents.size).toBe(0)
    const isDestroyed = handle.guest.isDestroyed
    expect(vi.isMockFunction(isDestroyed)).toBe(true)
    if (vi.isMockFunction(isDestroyed)) {
      isDestroyed.mockReturnValue(true)
    }
    gate.resolve()
    await expect(result).resolves.toBe(false)
    expect(registeredGuests.size).toBe(0)
    expect(presetIntents.size).toBe(0)
    expect(uaIntents.get('closed')).toBeUndefined()
  })

  it('does not restore closed-tab UA intent after a failed clear', async () => {
    const handle = register('clear-close', 101)
    await expect(browserManager.setViewportOverride('clear-close', mobile)).resolves.toBe(true)
    const gate = pause(handle, 'Emulation.setUserAgentOverride')
    const result = browserManager.setViewportOverride('clear-close', null)
    await gate.entered
    browserManager.unregisterGuest('clear-close')
    const isDestroyed = handle.guest.isDestroyed
    expect(vi.isMockFunction(isDestroyed)).toBe(true)
    if (vi.isMockFunction(isDestroyed)) {
      isDestroyed.mockReturnValue(true)
    }
    gate.reject(new Error('Target closed'))
    await expect(result).resolves.toBe(false)
    expect(uaIntents.get('clear-close')).toBeUndefined()
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
    expect(uaIntents.get('replacement')).toBe(false)
    gate.reject(new Error('Old target closed'))
    await expect(result).resolves.toBe(false)
    expect(registeredGuests.get('replacement')).toBe(103)
    expect(uaIntents.get('replacement')).toBe(false)
    expect(presetIntents.get('replacement')).toEqual({
      guestWebContentsId: 103,
      active: true
    })
  })

  it('preserves replacement mobile intent after an old clear resumes', async () => {
    const handle = register('late-delete', 104)
    await browserManager.setViewportOverride('late-delete', desktop)
    const gate = pause(handle, 'Emulation.setTouchEmulationEnabled')
    const result = browserManager.setViewportOverride('late-delete', null)
    await gate.entered
    browserManager.unregisterGuest('late-delete')
    register('late-delete', 105)
    await browserManager.setViewportOverride('late-delete', mobile)
    gate.resolve()
    await expect(result).resolves.toBe(false)
    expect(uaIntents.has('late-delete')).toBe(true)
    expect(registeredGuests.get('late-delete')).toBe(105)
  })

  it('same-owner clear failure still restores the legitimate earlier intent', async () => {
    const handle = register('same-owner', 106)
    await browserManager.setViewportOverride('same-owner', mobile)
    const gate = pause(handle, 'Emulation.setUserAgentOverride')
    const result = browserManager.setViewportOverride('same-owner', null)
    await gate.entered
    gate.reject(new Error('Protocol error'))
    await expect(result).resolves.toBe(false)
    expect(uaIntents.get('same-owner')).toBe(true)
  })

  it('old apply cannot overwrite a replacement guest desktop intent', async () => {
    const old = register('late-apply', 110)
    const gate = pause(old, 'Emulation.setTouchEmulationEnabled')
    const pending = browserManager.setViewportOverride('late-apply', mobile)
    await gate.entered
    browserManager.unregisterGuest('late-apply')
    register('late-apply', 111)
    await browserManager.setViewportOverride('late-apply', desktop)
    gate.resolve()
    await expect(pending).resolves.toBe(false)
    expect(uaIntents.get('late-apply')).toBe(false)
  })

  it('an old guest cannot write UA intent after replacement in native process mode', async () => {
    mocks.processUserAgentMode = 'native'
    mocks.processUserAgent = GUEST_ELECTRON_UA
    const old = register('native-replacement', 112)
    const gate = pause(old, 'Emulation.setTouchEmulationEnabled')
    const pending = browserManager.setViewportOverride('native-replacement', mobile)
    await gate.entered
    browserManager.unregisterGuest('native-replacement')
    register('native-replacement', 113)
    gate.resolve()
    await expect(pending).resolves.toBe(false)
    expect(uaIntents.get('native-replacement')).toBeUndefined()
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
    expect(uaIntents.get('queued-replacement')).toBe(true)
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
    expect(handle.debuggerSendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride'
    ])
    expect(pendingOperations.size).toBe(0)
    expect(uaIntents.size).toBe(0)
  })

  it.each([false, true])(
    'keeps process-wide native UA behavior with mobile=%s',
    async (mobileMode) => {
      mocks.processUserAgentMode = 'native'
      mocks.processUserAgent = GUEST_ELECTRON_UA
      const handle = register('native', 117)
      await expect(
        browserManager.setViewportOverride('native', mobileMode ? mobile : desktop)
      ).resolves.toBe(true)
      expect(handle.debuggerSendCommand).toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        mobileMode
          ? expect.objectContaining({ userAgent: expect.stringContaining('iPhone') })
          : { userAgent: GUEST_ELECTRON_UA }
      )
      expect(uaIntents.get('native')).toBe(mobileMode)
    }
  )

  it('late rejected clears cannot repopulate all registries after unregisterAll', async () => {
    const operations: { gate: ReturnType<typeof pause>; pending: Promise<boolean> }[] = []
    for (let index = 0; index < 16; index++) {
      const tab = `all-closed-${index}`
      const handle = register(tab, 200 + index)
      await browserManager.setViewportOverride(tab, mobile)
      const gate = pause(handle, 'Emulation.setUserAgentOverride')
      const pending = browserManager.setViewportOverride(tab, null)
      await gate.entered
      operations.push({ gate, pending })
    }
    browserManager.unregisterAll()
    for (const { gate } of operations) {
      gate.reject(new Error('Target closed'))
    }
    expect(await Promise.all(operations.map(({ pending }) => pending))).toEqual(
      Array(16).fill(false)
    )
    expect(uaIntents.size).toBe(0)
    expect(registeredGuests.size).toBe(0)
    expect(pendingOperations.size).toBe(0)
    expect(presetIntents.size).toBe(0)
  })
})
