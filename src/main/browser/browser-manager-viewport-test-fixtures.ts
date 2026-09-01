import { vi } from 'vitest'
import type { BrowserManagerMocks } from './browser-manager-test-harness'

export const GUEST_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'

// Why: viewport UA writes are queued on the per-tab chain, so draining it takes more than one
// microtask hop; loop until the chain is empty rather than guessing a tick count.
export async function flushViewportOps(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

export type ViewportGuestHandle = {
  guest: Record<string, unknown>
  debuggerSendCommand: ReturnType<typeof vi.fn>
  debuggerIsAttached: ReturnType<typeof vi.fn>
  debuggerAttach: ReturnType<typeof vi.fn>
  setGuestUserAgent: (ua: string) => void
  commitNavigationTo: (nextUrl: string) => void
}

// Why: the guest wires the file's own hoisted mocks, which cannot be imported here.
export function createViewportGuestFactory(
  mocks: BrowserManagerMocks
): (id: number, url?: string) => ViewportGuestHandle {
  return function makeGuest(id: number, url = 'https://example.com/'): ViewportGuestHandle {
    const debuggerSendCommand = vi.fn().mockResolvedValue(undefined)
    const debuggerIsAttached = vi.fn(() => true)
    const debuggerAttach = vi.fn()
    let currentUa = GUEST_ELECTRON_UA
    // Why: getURL() reports the last COMMITTED url — it does not move at did-start-navigation.
    let committedUrl = url
    const guest = {
      id,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      getURL: vi.fn(() => committedUrl),
      getUserAgent: vi.fn(() => currentUa),
      setUserAgent: vi.fn((ua: string) => {
        currentUa = ua
      }),
      session: { getUserAgent: vi.fn(() => GUEST_ELECTRON_UA) },
      setBackgroundThrottling: mocks.guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: mocks.guestSetWindowOpenHandlerMock,
      on: mocks.guestOnMock,
      off: mocks.guestOffMock,
      openDevTools: mocks.guestOpenDevToolsMock,
      executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(true),
      debugger: {
        isAttached: debuggerIsAttached,
        attach: debuggerAttach,
        sendCommand: debuggerSendCommand
      }
    }
    return {
      guest,
      debuggerSendCommand,
      debuggerIsAttached,
      debuggerAttach,
      setGuestUserAgent: (ua: string) => {
        currentUa = ua
      },
      commitNavigationTo: (nextUrl: string) => {
        committedUrl = nextUrl
      }
    }
  }
}
