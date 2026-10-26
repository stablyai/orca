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
})
