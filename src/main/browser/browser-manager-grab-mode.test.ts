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

import { browserManager } from './browser-manager'
import {
  GRAB_RENDERER_WEB_CONTENTS_ID,
  resetGrabTestEnvironment
} from './browser-manager-grab-test-harness'

const { guestExecuteJavaScriptMock, guestIsDestroyedMock } = grabMocks

describe('browserManager grab operations', () => {
  let guest: Electron.WebContents

  beforeEach(() => {
    guest = resetGrabTestEnvironment(grabMocks)
  })

  describe('getAuthorizedGuest', () => {
    it('returns guest for authorized caller', () => {
      const result = browserManager.getAuthorizedGuest('tab-1', GRAB_RENDERER_WEB_CONTENTS_ID)
      expect(result).toBe(guest)
    })

    it('returns null for unauthorized caller', () => {
      const result = browserManager.getAuthorizedGuest('tab-1', 9999)
      expect(result).toBeNull()
    })

    it('returns null for unregistered tab', () => {
      const result = browserManager.getAuthorizedGuest('unknown-tab', GRAB_RENDERER_WEB_CONTENTS_ID)
      expect(result).toBeNull()
    })

    it('returns null and cleans up if guest is destroyed', () => {
      guestIsDestroyedMock.mockReturnValue(true)
      const result = browserManager.getAuthorizedGuest('tab-1', GRAB_RENDERER_WEB_CONTENTS_ID)
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

    it('tears down an armed overlay when disabling before selection starts', async () => {
      const result = await browserManager.setGrabMode('tab-1', false, guest)

      expect(result).toBe(true)
      expect(guestExecuteJavaScriptMock).toHaveBeenCalledTimes(1)
      expect(guestExecuteJavaScriptMock.mock.calls[0][0]).toContain('grab.cleanup()')
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
})
