/* eslint-disable max-lines -- Why: grab operation tests cover authorization,
lifecycle (arm/await/cancel/teardown), navigation/destruction auto-cancel, and
main-side payload validation. Splitting across files would scatter the shared
mock setup and make it harder to verify the grab contract holistically. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  webContentsFromIdMock,
  guestOnMock,
  guestOffMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestExecuteJavaScriptMock,
  guestIsDestroyedMock,
  guestGetZoomFactorMock,
  guestCapturePageMock,
  menuBuildFromTemplateMock
} = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestExecuteJavaScriptMock: vi.fn(),
  guestIsDestroyedMock: vi.fn(() => false),
  guestGetZoomFactorMock: vi.fn(() => 1),
  guestCapturePageMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: menuBuildFromTemplateMock },
  webContents: { fromId: webContentsFromIdMock }
}))

import { browserManager } from './browser-manager'

function makeGuest(id: number) {
  return {
    id,
    isDestroyed: guestIsDestroyedMock,
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: guestSetWindowOpenHandlerMock,
    on: guestOnMock,
    off: guestOffMock,
    openDevTools: vi.fn(),
    executeJavaScript: guestExecuteJavaScriptMock,
    getZoomFactor: guestGetZoomFactorMock,
    capturePage: guestCapturePageMock,
    getURL: vi.fn(() => 'https://example.com/')
  } as unknown as Electron.WebContents
}

describe('browserManager grab operations', () => {
  const rendererWebContentsId = 5001
  let guest: Electron.WebContents

  beforeEach(() => {
    vi.clearAllMocks()
    guestIsDestroyedMock.mockReturnValue(false)
    guestExecuteJavaScriptMock.mockResolvedValue(true)
    browserManager.unregisterAll()

    guest = makeGuest(101)
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest)
    browserManager.registerGuest({
      browserTabId: 'tab-1',
      webContentsId: 101,
      rendererWebContentsId
    })
  })

  describe('getAuthorizedGuest', () => {
    it('returns guest for authorized caller', () => {
      const result = browserManager.getAuthorizedGuest('tab-1', rendererWebContentsId)
      expect(result).toBe(guest)
    })

    it('returns null for unauthorized caller', () => {
      const result = browserManager.getAuthorizedGuest('tab-1', 9999)
      expect(result).toBeNull()
    })

    it('returns null for unregistered tab', () => {
      const result = browserManager.getAuthorizedGuest('unknown-tab', rendererWebContentsId)
      expect(result).toBeNull()
    })

    it('returns null and cleans up if guest is destroyed', () => {
      guestIsDestroyedMock.mockReturnValue(true)
      const result = browserManager.getAuthorizedGuest('tab-1', rendererWebContentsId)
      expect(result).toBeNull()
    })
  })

  describe('setGrabMode', () => {
    it('injects overlay when enabling grab mode', async () => {
      const result = await browserManager.setGrabMode('tab-1', true, guest)
      expect(result).toBe(true)
      expect(guestExecuteJavaScriptMock).toHaveBeenCalledTimes(1)
      expect(guestExecuteJavaScriptMock.mock.calls[0][0]).toContain('__orca-grab-host')
    })

    it('cancels active grab op when disabling', async () => {
      // Start a grab op first
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      const selectionPromise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      // Disable grab mode
      const result = await browserManager.setGrabMode('tab-1', false, guest)
      expect(result).toBe(true)

      const selection = await selectionPromise
      expect(selection.kind).toBe('cancelled')
      expect(selection.opId).toBe('op-1')
    })

    it('returns false if injection fails', async () => {
      guestExecuteJavaScriptMock.mockRejectedValue(new Error('Injection failed'))
      const result = await browserManager.setGrabMode('tab-1', true, guest)
      expect(result).toBe(false)
    })
  })

  describe('hasActiveGrabOp', () => {
    it('returns false when no grab is active', () => {
      expect(browserManager.hasActiveGrabOp('tab-1')).toBe(false)
    })

    it('returns true when a grab is active', () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      void browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(browserManager.hasActiveGrabOp('tab-1')).toBe(true)
    })
  })

  describe('awaitGrabSelection', () => {
    it('resolves with selected payload when guest returns data', async () => {
      const mockPayload = {
        page: {
          sanitizedUrl: 'https://example.com/',
          title: 'Example',
          viewportWidth: 1280,
          viewportHeight: 720,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 2,
          capturedAt: '2026-04-10T00:00:00.000Z'
        },
        target: {
          tagName: 'button',
          selector: 'button',
          textSnippet: 'Click me',
          htmlSnippet: '<button>Click me</button>',
          attributes: {},
          accessibility: {
            role: 'button',
            accessibleName: 'Click me',
            ariaLabel: null,
            ariaLabelledBy: null
          },
          rectViewport: { x: 0, y: 0, width: 100, height: 40 },
          rectPage: { x: 0, y: 0, width: 100, height: 40 },
          computedStyles: {
            display: 'block',
            position: 'static',
            width: '100px',
            height: '40px',
            margin: '0',
            padding: '0',
            color: '#000',
            backgroundColor: '#fff',
            border: 'none',
            borderRadius: '0',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            fontWeight: '400',
            lineHeight: '20px',
            textAlign: 'left',
            zIndex: 'auto'
          }
        },
        nearbyText: [],
        ancestorPath: ['div', 'body'],
        screenshot: null
      }

      // The awaitClick script returns a Promise; simulate it resolving
      guestExecuteJavaScriptMock.mockResolvedValueOnce(mockPayload)

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('selected')
      expect(result.opId).toBe('op-1')
      if (result.kind === 'selected') {
        expect(result.payload.target.tagName).toBe('button')
      }
    })

    it('resolves with cancelled when guest returns null', async () => {
      guestExecuteJavaScriptMock.mockResolvedValueOnce(null)

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('cancelled')
    })

    it('resolves with error when executeJavaScript throws', async () => {
      guestExecuteJavaScriptMock.mockRejectedValueOnce(new Error('Script failed'))

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('error')
      if (result.kind === 'error') {
        expect(result.reason).toContain('Script failed')
      }
    })

    it('resolves with error when guest returns structurally invalid payload', async () => {
      // Missing required 'target' field
      guestExecuteJavaScriptMock.mockResolvedValueOnce({ page: { title: 'test' } })

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('error')
      if (result.kind === 'error') {
        expect(result.reason).toContain('invalid payload')
      }
    })

    it('main-side clamp redacts secret-bearing attribute values', async () => {
      const mockPayload = {
        page: {
          sanitizedUrl: 'https://example.com/',
          title: 'Example',
          viewportWidth: 1280,
          viewportHeight: 720,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 2,
          capturedAt: '2026-04-10T00:00:00.000Z'
        },
        target: {
          tagName: 'div',
          selector: 'div',
          textSnippet: '',
          htmlSnippet: '<div></div>',
          attributes: {
            id: 'safe-value',
            class: 'access_token=secret123',
            href: 'https://example.com/callback?access_token=abc',
            src: 'https://example.com/img?size=large&color=blue',
            'aria-label': 'password is hunter2'
          },
          accessibility: {
            role: 'generic',
            accessibleName: null,
            ariaLabel: null,
            ariaLabelledBy: null
          },
          rectViewport: { x: 0, y: 0, width: 100, height: 40 },
          rectPage: { x: 0, y: 0, width: 100, height: 40 },
          computedStyles: {
            display: 'block',
            position: 'static',
            width: '100px',
            height: '40px',
            margin: '0',
            padding: '0',
            color: '#000',
            backgroundColor: '#fff',
            border: 'none',
            borderRadius: '0',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            fontWeight: '400',
            lineHeight: '20px',
            textAlign: 'left',
            zIndex: 'auto'
          }
        },
        nearbyText: [],
        ancestorPath: [],
        screenshot: null
      }

      guestExecuteJavaScriptMock.mockResolvedValueOnce(mockPayload)
      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('selected')
      if (result.kind === 'selected') {
        const attrs = result.payload.target.attributes
        // Safe value passes through
        expect(attrs.id).toBe('safe-value')
        // Class with secret pattern is redacted
        expect(attrs.class).toBe('[redacted]')
        // href containing a secret pattern is redacted (secret check takes
        // priority over URL sanitization for defense in depth)
        expect(attrs.href).toBe('[redacted]')
        // src with non-secret query params is sanitized (query stripped)
        expect(attrs.src).toBe('https://example.com/img')
        // aria-label with secret pattern is redacted
        expect(attrs['aria-label']).toBe('[redacted]')
      }
    })

    it('main-side clamp re-sanitizes page URL with query strings', async () => {
      const mockPayload = {
        page: {
          sanitizedUrl: 'https://example.com/page?access_token=secret&foo=bar#hash',
          title: 'Test',
          viewportWidth: 1280,
          viewportHeight: 720,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 1,
          capturedAt: '2026-04-10T00:00:00.000Z'
        },
        target: {
          tagName: 'div',
          selector: 'div',
          textSnippet: '',
          htmlSnippet: '<div></div>',
          attributes: {},
          accessibility: {
            role: null,
            accessibleName: null,
            ariaLabel: null,
            ariaLabelledBy: null
          },
          rectViewport: { x: 0, y: 0, width: 10, height: 10 },
          rectPage: { x: 0, y: 0, width: 10, height: 10 },
          computedStyles: {
            display: 'block',
            position: 'static',
            width: '10px',
            height: '10px',
            margin: '0',
            padding: '0',
            color: '#000',
            backgroundColor: '#fff',
            border: 'none',
            borderRadius: '0',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            fontWeight: '400',
            lineHeight: '20px',
            textAlign: 'left',
            zIndex: 'auto'
          }
        },
        nearbyText: [],
        ancestorPath: [],
        screenshot: null
      }

      guestExecuteJavaScriptMock.mockResolvedValueOnce(mockPayload)
      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('selected')
      if (result.kind === 'selected') {
        // Query string and hash should be stripped by main-side sanitization
        expect(result.payload.page.sanitizedUrl).toBe('https://example.com/page')
      }
    })

    it('cancels previous op when starting a new one on same tab', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise1 = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      // Start a second grab op on same tab
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      void browserManager.awaitGrabSelection('tab-1', 'op-2', guest)

      const result1 = await promise1
      expect(result1.kind).toBe('cancelled')
      expect(result1.opId).toBe('op-1')
    })

    it('replacement op skips teardown injection to preserve overlay', async () => {
      // Why: when replacing an op, the old op's cleanup must NOT inject the
      // teardown script because the new op reuses the already-armed overlay.
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      void browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      // Record call count before replacement
      const callCountBefore = guestExecuteJavaScriptMock.mock.calls.length

      // Replace with a new op
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      void browserManager.awaitGrabSelection('tab-1', 'op-2', guest)

      // The only new executeJavaScript call should be the awaitClick for op-2.
      // No teardown should have been injected for op-1's cleanup.
      // Why: distinguish teardown from awaitClick — both contain 'cancelAwait',
      // but only the teardown script contains 'if (!grab) return true;'.
      const newCalls = guestExecuteJavaScriptMock.mock.calls.slice(callCountBefore)
      const teardownCalls = newCalls.filter(([script]) =>
        (script as string).includes('if (!grab) return true;')
      )
      expect(teardownCalls).toHaveLength(0)
    })
  })

  describe('cancelGrabOp', () => {
    it('resolves active grab with cancelled reason', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      browserManager.cancelGrabOp('tab-1', 'user')

      const result = await promise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'user' })
    })

    it('is a no-op when no grab is active', () => {
      // Should not throw
      browserManager.cancelGrabOp('tab-1', 'user')
    })

    it('supports different cancellation reasons', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      browserManager.cancelGrabOp('tab-1', 'navigation')

      const result = await promise
      expect(result.kind).toBe('cancelled')
      if (result.kind === 'cancelled') {
        expect(result.reason).toBe('navigation')
      }
    })
  })

  describe('unregisterGuest cancels grab', () => {
    it('cancels active grab on unregister', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      browserManager.unregisterGuest('tab-1')

      const result = await promise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'evicted' })
    })
  })

  describe('navigation auto-cancel', () => {
    it('cancels grab when guest navigates in main frame', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      // Find the did-start-navigation handler and trigger it with isMainFrame=true
      const navHandler = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as ((...args: unknown[]) => void) | undefined

      expect(navHandler).toBeTypeOf('function')
      navHandler?.(null, 'https://example.com/new', false, true)

      const result = await promise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'navigation' })
    })

    it('does not cancel grab on subframe navigation', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      void browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      // Trigger did-start-navigation with isMainFrame=false (subframe)
      const navHandler = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as ((...args: unknown[]) => void) | undefined

      expect(navHandler).toBeTypeOf('function')
      navHandler?.(null, 'https://ads.example.com/', false, false)

      // Grab should still be active
      expect(browserManager.hasActiveGrabOp('tab-1')).toBe(true)
    })
  })

  describe('destruction auto-cancel', () => {
    it('cancels grab when guest is destroyed', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      // Find the destroyed handler and trigger it
      const destroyedHandler = guestOnMock.mock.calls.find(
        ([event]) => event === 'destroyed'
      )?.[1] as (() => void) | undefined

      expect(destroyedHandler).toBeTypeOf('function')
      destroyedHandler?.()

      const result = await promise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'evicted' })
    })
  })
})
