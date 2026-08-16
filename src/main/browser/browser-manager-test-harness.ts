import { vi, type Mock } from 'vitest'
import { browserManager } from './browser-manager'

export const rendererWebContentsId = 5001
// Base (non-Firefox) UA a guest reports off the Google auth hosts.
export const guestBaseUserAgent = 'Mozilla/5.0 (Test) Chrome/140.0.0.0'

export type GuestUserAgentMethods = {
  getUserAgent: Mock<() => string>
  setUserAgent: Mock<(userAgent: string) => void>
  session: { getUserAgent: Mock<() => string> }
}

export const guestUaMethods = (): GuestUserAgentMethods => ({
  getUserAgent: vi.fn(() => guestBaseUserAgent),
  setUserAgent: vi.fn(),
  session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
})

// Why: vi.mock factories are hoisted per file, so every browser-manager test file declares its own
// vi.hoisted bundle; this is the shape they all produce.
export type BrowserManagerMocks = {
  appGetPathMock: Mock
  shellOpenExternalMock: Mock
  browserWindowFromWebContentsMock: Mock
  menuBuildFromTemplateMock: Mock
  guestOffMock: Mock
  guestOnMock: Mock
  guestSetBackgroundThrottlingMock: Mock
  guestSetWindowOpenHandlerMock: Mock
  guestOpenDevToolsMock: Mock
  webContentsFromIdMock: Mock
  screenGetCursorScreenPointMock: Mock
  openPopupWithOriginBarMock: Mock
}

export function resetBrowserManagerMocks(mocks: BrowserManagerMocks): void {
  mocks.appGetPathMock.mockReset()
  mocks.appGetPathMock.mockReturnValue('/downloads')
  mocks.shellOpenExternalMock.mockReset()
  mocks.browserWindowFromWebContentsMock.mockReset()
  mocks.menuBuildFromTemplateMock.mockReset()
  mocks.guestOffMock.mockReset()
  mocks.guestOnMock.mockReset()
  mocks.guestSetBackgroundThrottlingMock.mockReset()
  mocks.guestSetWindowOpenHandlerMock.mockReset()
  mocks.guestOpenDevToolsMock.mockReset()
  mocks.webContentsFromIdMock.mockReset()
  mocks.openPopupWithOriginBarMock.mockReset()
}

export function resetBrowserManagerState(): void {
  browserManager.unregisterAll()
  browserManager.setBrowserGuestStateChangedListener(null)
  browserManager.setDictationShortcutForwardingPredicate(null)
  browserManager.setSettingsResolver(() => ({}))
}

type DownloadItemHandlerState = 'progressing' | 'interrupted' | 'completed' | 'cancelled'
type DownloadItemHandler = (event: Electron.Event, state: DownloadItemHandlerState) => void

export function createDownloadItem(
  overrides: Partial<Electron.DownloadItem> = {}
): Electron.DownloadItem {
  return {
    setSavePath: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    cancel: vi.fn(),
    getFilename: vi.fn(() => 'report.csv'),
    getTotalBytes: vi.fn(() => 2048),
    getMimeType: vi.fn(() => 'text/csv'),
    getURL: vi.fn(() => 'https://example.com/report.csv'),
    getReceivedBytes: vi.fn(() => 0),
    ...overrides
  } as unknown as Electron.DownloadItem
}

export function getDownloadItemEventHandler(
  item: Electron.DownloadItem,
  method: 'on' | 'once',
  eventName: string
): DownloadItemHandler | undefined {
  const eventMock = item[method] as unknown as {
    mock: { calls: [string, DownloadItemHandler][] }
  }
  return eventMock.mock.calls.find(([event]) => event === eventName)?.[1]
}
