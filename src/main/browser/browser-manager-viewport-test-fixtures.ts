import { vi } from 'vitest'
import type { BrowserManagerMocks } from './browser-manager-test-harness'

export const GUEST_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
export const GUEST_CLEAN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

// Why: viewport UA writes are queued on the per-tab chain, so draining it takes more than one
// microtask hop; loop until the chain is empty rather than guessing a tick count.
export async function flushViewportOps(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

// Why: mirrors Chromium, which rejects an out-of-range maxTouchPoints even when disabling touch.
async function rejectInvalidTouchPoints(
  method: string,
  params?: { maxTouchPoints?: number }
): Promise<undefined> {
  const points = params?.maxTouchPoints
  if (
    method === 'Emulation.setTouchEmulationEnabled' &&
    points !== undefined &&
    (points < 1 || points > 16)
  ) {
    throw new Error('Touch points must be between 1 and 16')
  }
  return undefined
}

export type ViewportGuestHandle = {
  guest: Record<string, unknown>
  debuggerSendCommand: ReturnType<typeof vi.fn>
  debuggerIsAttached: ReturnType<typeof vi.fn>
  debuggerAttach: ReturnType<typeof vi.fn>
  /** Flips what isCrashed() reports, as a renderer death and its reload do. */
  setRendererCrashed: (crashed: boolean) => void
  setGuestUserAgent: (ua: string) => void
  commitNavigationTo: (nextUrl: string) => void
  webContentsUserAgent: () => string
  /** What navigator.userAgent reports: the latest applied CDP override, else the WebContents UA. */
  presentedUserAgent: () => string
  /** The CDP UA override Chromium holds, or null when none stands. */
  standingUserAgentOverride: () => Record<string, unknown> | null
}

// Why: the guest wires the file's own hoisted mocks, which cannot be imported here.
// Why the process identity: the session UA and app.userAgentFallback both carry it, so that is what a
// real guest's getUserAgent() reports until something writes the WebContents UA.
export function createViewportGuestFactory(
  mocks: BrowserManagerMocks & { processUserAgent?: string }
): (id: number, url?: string) => ViewportGuestHandle {
  return function makeGuest(id: number, url = 'https://example.com/'): ViewportGuestHandle {
    const debuggerSendCommand = vi.fn(rejectInvalidTouchPoints)
    const debuggerIsAttached = vi.fn(() => true)
    const debuggerAttach = vi.fn()
    let currentUa = mocks.processUserAgent ?? GUEST_ELECTRON_UA
    let rendererCrashed = false
    // Why: getURL() reports the last COMMITTED url — it does not move at did-start-navigation.
    let committedUrl = url
    // Chromium applies CDP commands in issue order, so a later-issued write wins however they settle,
    // and a rejected write changes nothing. An empty userAgent clears the override.
    let issuedUserAgentWrites = 0
    let appliedUserAgentWrite = 0
    let cdpOverride: Record<string, unknown> | null = null
    const sendCommand = (method: string, params?: Record<string, unknown>): unknown => {
      const result: unknown = debuggerSendCommand(method, params)
      if (method === 'Emulation.setUserAgentOverride') {
        const ordinal = ++issuedUserAgentWrites
        void Promise.resolve(result).then(
          () => {
            if (ordinal > appliedUserAgentWrite) {
              appliedUserAgentWrite = ordinal
              cdpOverride = params?.userAgent ? params : null
            }
          },
          () => {}
        )
      }
      return result
    }
    const guest = {
      id,
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => rendererCrashed),
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
        sendCommand,
        on: vi.fn(),
        off: vi.fn()
      }
    }
    return {
      guest,
      debuggerSendCommand,
      debuggerIsAttached,
      debuggerAttach,
      setRendererCrashed: (crashed: boolean) => {
        rendererCrashed = crashed
      },
      setGuestUserAgent: (ua: string) => {
        currentUa = ua
      },
      commitNavigationTo: (nextUrl: string) => {
        committedUrl = nextUrl
      },
      webContentsUserAgent: () => currentUa,
      presentedUserAgent: () =>
        typeof cdpOverride?.userAgent === 'string' ? cdpOverride.userAgent : currentUa,
      standingUserAgentOverride: () => cdpOverride
    }
  }
}
