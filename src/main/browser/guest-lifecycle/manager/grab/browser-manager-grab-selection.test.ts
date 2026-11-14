import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { browserManager } from '../browser-manager'
import {
  GRAB_GUEST_WEB_CONTENTS_ID,
  GRAB_RENDERER_WEB_CONTENTS_ID,
  makeGuest,
  resetGrabTestEnvironment,
  routeWebContentsIds
} from './browser-manager-grab-test-harness'

const { guestExecuteJavaScriptMock } = grabMocks

describe('browserManager grab operations', () => {
  let guest: Electron.WebContents

  beforeEach(() => {
    guest = resetGrabTestEnvironment(grabMocks)
  })

  describe('awaitGrabSelection', () => {
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
  })

  describe('unregisterGuest cancels grab', () => {
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
})
