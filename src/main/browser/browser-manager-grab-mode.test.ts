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

const { guestExecuteJavaScriptMock } = grabMocks

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
  })

  describe('setGrabMode', () => {
    it('cancels active grab op when disabling', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      const selectionPromise = browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

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
})
