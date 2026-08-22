import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GRAB_BUDGET } from '../../shared/browser-grab-types'

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
import { resetGrabTestEnvironment } from './browser-manager-grab-test-harness'

const { guestCapturePageMock, guestExecuteJavaScriptMock } = grabMocks

describe('browserManager grab operations', () => {
  let guest: Electron.WebContents

  beforeEach(() => {
    guest = resetGrabTestEnvironment(grabMocks)
  })

  describe('captureSelectionScreenshot', () => {
    it('captures, crops, and converts screenshot dimensions back to CSS pixels', async () => {
      const cropMock = vi.fn(() => ({
        toPNG: vi.fn(() => Buffer.from('png-data'))
      }))
      guestCapturePageMock.mockResolvedValue({
        isEmpty: vi.fn(() => false),
        getSize: vi.fn(() => ({ width: 2000, height: 1000 })),
        crop: cropMock
      })
      guestExecuteJavaScriptMock.mockImplementation(async (script: string) =>
        script === 'window.innerWidth' ? 1000 : undefined
      )

      const screenshot = await browserManager.captureSelectionScreenshot(
        'tab-1',
        { x: 10, y: 20, width: 100, height: 50 },
        guest
      )

      expect(cropMock).toHaveBeenCalledWith({ x: 20, y: 40, width: 200, height: 100 })
      expect(screenshot).toEqual({
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`,
        width: 100,
        height: 50
      })
      expect(guestExecuteJavaScriptMock).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('__orcaGrab')
      )
      expect(guestExecuteJavaScriptMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('__orcaGrab')
      )
      expect(guestExecuteJavaScriptMock).toHaveBeenNthCalledWith(3, 'window.innerWidth')
    })

    it('omits screenshots that exceed the byte budget', async () => {
      const oversizedBuffer = Buffer.alloc(GRAB_BUDGET.screenshotMaxBytes + 1)
      guestCapturePageMock.mockResolvedValue({
        isEmpty: vi.fn(() => false),
        getSize: vi.fn(() => ({ width: 1000, height: 500 })),
        crop: vi.fn(() => ({
          toPNG: vi.fn(() => oversizedBuffer)
        }))
      })
      guestExecuteJavaScriptMock.mockImplementation(async (script: string) =>
        script === 'window.innerWidth' ? 1000 : undefined
      )

      const screenshot = await browserManager.captureSelectionScreenshot(
        'tab-1',
        { x: 0, y: 0, width: 100, height: 50 },
        guest
      )

      expect(screenshot).toBeNull()
    })
  })

  describe('extractHoverPayload', () => {
    it('returns a clamped payload when the guest reports a hovered element', async () => {
      guestExecuteJavaScriptMock.mockResolvedValueOnce({
        page: {
          sanitizedUrl: 'https://example.com/path?token=secret#hash',
          title: 'Hover target',
          viewportWidth: 1200,
          viewportHeight: 800,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 2,
          capturedAt: '2026-04-10T00:00:00.000Z'
        },
        target: {
          tagName: 'div',
          selector: 'div.card',
          textSnippet: 'x'.repeat(500),
          htmlSnippet: '<div>Hover</div>',
          attributes: {
            href: 'https://example.com/path?api_key=secret',
            onclick: 'alert(1)'
          },
          accessibility: {
            role: 'generic',
            accessibleName: 'Card',
            ariaLabel: null,
            ariaLabelledBy: null
          },
          rectViewport: { x: 5, y: 10, width: 50, height: 25 },
          rectPage: { x: 5, y: 10, width: 50, height: 25 },
          computedStyles: {
            display: 'block',
            position: 'relative',
            width: '50px',
            height: '25px',
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
            zIndex: '1'
          }
        },
        nearbyText: [],
        ancestorPath: [],
        screenshot: null
      })

      const payload = await browserManager.extractHoverPayload('tab-1', guest)

      expect(payload).not.toBeNull()
      expect(payload?.page.sanitizedUrl).toBe('https://example.com/path')
      expect(payload?.target.textSnippet).toContain('(truncated)')
      expect(payload?.target.attributes.href).toBe('[redacted]')
      expect(payload?.target.attributes.onclick).toBeUndefined()
    })

    it('returns null for structurally invalid guest payloads', async () => {
      guestExecuteJavaScriptMock.mockResolvedValueOnce({ page: { title: 'missing-target' } })

      const payload = await browserManager.extractHoverPayload('tab-1', guest)

      expect(payload).toBeNull()
    })
  })
})
