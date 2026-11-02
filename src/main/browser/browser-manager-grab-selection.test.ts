import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGrabPayload } from '../../shared/browser-grab-types'

const grabMocks = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestExecuteJavaScriptMock: vi.fn(),
  guestExecuteJavaScriptInIsolatedWorldMock: vi.fn(),
  guestIsDestroyedMock: vi.fn(() => false),
  guestGetZoomFactorMock: vi.fn(() => 1),
  guestCapturePageMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  rendererSendMock: vi.fn(),
  rendererIsDestroyedMock: vi.fn(() => false)
}))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: grabMocks.menuBuildFromTemplateMock },
  webContents: { fromId: grabMocks.webContentsFromIdMock }
}))

import { browserManager } from './browser-manager'
import {
  GRAB_GUEST_WEB_CONTENTS_ID,
  GRAB_RENDERER_WEB_CONTENTS_ID,
  makeGuest,
  resetGrabTestEnvironment,
  routeWebContentsIds
} from './browser-manager-grab-test-harness'

const { guestExecuteJavaScriptMock, guestOnMock } = grabMocks

function makeValidGrabPayload(): BrowserGrabPayload {
  return {
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
}

describe('browserManager grab operations', () => {
  let guest: Electron.WebContents

  beforeEach(() => {
    guest = resetGrabTestEnvironment(grabMocks)
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

    it('resolves with cancelled when guest returns teardown cancellation marker', async () => {
      guestExecuteJavaScriptMock.mockResolvedValueOnce({ __orcaCancelled: true })

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'user' })
    })

    it('resolves with cancelled when guest returns a serialized cancelled error', async () => {
      guestExecuteJavaScriptMock.mockResolvedValueOnce({ message: 'cancelled' })

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'user' })
    })

    it('resolves with cancelled when executeJavaScript rejects a serialized cancelled error', async () => {
      guestExecuteJavaScriptMock.mockRejectedValueOnce({ message: 'cancelled' })

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'user' })
    })

    it('does not treat a valid payload message field as cancellation', async () => {
      guestExecuteJavaScriptMock.mockResolvedValueOnce({
        ...makeValidGrabPayload(),
        message: 'cancelled'
      })

      const result = await browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      expect(result.kind).toBe('selected')
      if (result.kind === 'selected') {
        expect(result.payload.target.tagName).toBe('button')
      }
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
        expect(attrs.id).toBe('safe-value')
        expect(attrs.class).toBe('[redacted]')
        // Secret-pattern redaction takes precedence over URL sanitization.
        expect(attrs.href).toBe('[redacted]')
        expect(attrs.src).toBe('https://example.com/img')
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
        expect(result.payload.page.sanitizedUrl).toBe('https://example.com/page')
      }
    })

    it('cancels previous op when starting a new one on same tab', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise1 = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      void browserManager.awaitGrabSelection('tab-1', 'op-2', guest)

      const result1 = await promise1
      expect(result1.kind).toBe('cancelled')
      expect(result1.opId).toBe('op-1')
    })

    it('replacement op skips teardown injection to preserve overlay', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      void browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      const callCountBefore = guestExecuteJavaScriptMock.mock.calls.length

      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      void browserManager.awaitGrabSelection('tab-1', 'op-2', guest)

      // Both scripts contain cancelAwait; only teardown contains 'if (!grab) return true;'.
      const newCalls = guestExecuteJavaScriptMock.mock.calls.slice(callCountBefore)
      const teardownCalls = newCalls.filter(([script]) =>
        (script as string).includes('if (!grab) return true;')
      )
      expect(teardownCalls).toHaveLength(0)
    })

    it('times out if the guest never settles the armed selection', async () => {
      vi.useFakeTimers()
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const resultPromise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      await vi.advanceTimersByTimeAsync(120_000)

      const result = await resultPromise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'timeout' })

      vi.useRealTimers()
    })

    it('ignores a late guest selection after the op was already cancelled', async () => {
      let resolveGuestSelection!: (value: unknown) => void
      guestExecuteJavaScriptMock.mockImplementation(
        () =>
          new Promise<unknown>((resolve) => {
            resolveGuestSelection = resolve
          })
      )

      const resultPromise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      browserManager.cancelGrabOp('tab-1', 'user')

      expect(resolveGuestSelection).toBeTypeOf('function')
      resolveGuestSelection({
        page: {
          sanitizedUrl: 'https://example.com/',
          title: 'Late result',
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
          textSnippet: 'Late click',
          htmlSnippet: '<button>Late click</button>',
          attributes: {},
          accessibility: {
            role: 'button',
            accessibleName: 'Late click',
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
      })

      const result = await resultPromise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'user' })
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

    it('cancels active grab when the same tab is re-registered to a new guest', async () => {
      const replacementGuest = makeGuest(202, grabMocks)
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)
      routeWebContentsIds(grabMocks, {
        [GRAB_GUEST_WEB_CONTENTS_ID]: guest,
        202: replacementGuest
      })
      browserManager.attachGuestPolicies(replacementGuest)
      browserManager.registerGuest({
        browserPageId: 'tab-1',
        webContentsId: 202,
        rendererWebContentsId: GRAB_RENDERER_WEB_CONTENTS_ID
      })

      const result = await promise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'evicted' })
    })
  })

  describe('navigation auto-cancel', () => {
    it('cancels grab when guest navigates in main frame', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      const navHandler = guestOnMock.mock.calls.findLast(
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

      const navHandler = guestOnMock.mock.calls.findLast(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as ((...args: unknown[]) => void) | undefined

      expect(navHandler).toBeTypeOf('function')
      navHandler?.(null, 'https://ads.example.com/', false, false)

      expect(browserManager.hasActiveGrabOp('tab-1')).toBe(true)
    })

    it('does not cancel grab when the page rewrites its URL in place', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      void browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      const navHandler = guestOnMock.mock.calls.findLast(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as ((...args: unknown[]) => void) | undefined

      expect(navHandler).toBeTypeOf('function')
      navHandler?.(null, 'https://example.com/#section-2', true, true)

      expect(browserManager.hasActiveGrabOp('tab-1')).toBe(true)
    })
  })

  describe('destruction auto-cancel', () => {
    it('cancels grab when guest is destroyed', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))

      const promise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      const destroyedHandler = guestOnMock.mock.calls.findLast(
        ([event]) => event === 'destroyed'
      )?.[1] as (() => void) | undefined

      expect(destroyedHandler).toBeTypeOf('function')
      destroyedHandler?.()

      const result = await promise
      expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'evicted' })
    })
  })
})
