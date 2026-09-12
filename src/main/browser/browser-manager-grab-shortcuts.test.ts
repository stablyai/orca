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
import { resetGrabTestEnvironment } from './browser-manager-grab-test-harness'

const { guestExecuteJavaScriptMock, guestOnMock, rendererSendMock } = grabMocks

describe('browserManager grab operations', () => {
  const primaryModifier =
    process.platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
  let guest: Electron.WebContents

  beforeEach(() => {
    guest = resetGrabTestEnvironment(grabMocks)
  })

  describe('grab shortcut forwarding', () => {
    it('forwards cmd/ctrl+c from the guest when the page is not using copy', async () => {
      const handler = guestOnMock.mock.calls.find(
        ([eventName]) => eventName === 'before-input-event'
      )?.[1]
      expect(handler).toBeTypeOf('function')

      guestExecuteJavaScriptMock.mockResolvedValueOnce(true)
      const preventDefault = vi.fn()
      handler?.(
        { preventDefault } as never,
        {
          type: 'keyDown',
          ...primaryModifier,
          shift: false,
          alt: false,
          key: 'c'
        } as never
      )

      await Promise.resolve()
      await Promise.resolve()

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(rendererSendMock).toHaveBeenCalledWith('browser:grabModeToggle', 'tab-1')
    })

    it('does not forward cmd/ctrl+c when the guest reports native copy should win', async () => {
      const handler = guestOnMock.mock.calls.find(
        ([eventName]) => eventName === 'before-input-event'
      )?.[1]
      expect(handler).toBeTypeOf('function')

      guestExecuteJavaScriptMock.mockResolvedValueOnce(false)
      const preventDefault = vi.fn()
      handler?.(
        { preventDefault } as never,
        {
          type: 'keyDown',
          ...primaryModifier,
          shift: false,
          alt: false,
          key: 'c'
        } as never
      )

      await Promise.resolve()
      await Promise.resolve()

      expect(preventDefault).not.toHaveBeenCalled()
      expect(rendererSendMock).not.toHaveBeenCalled()
    })

    it('forwards bare s from the guest while a grab op is active', async () => {
      guestExecuteJavaScriptMock.mockImplementation(() => new Promise(() => {}))
      void browserManager.awaitGrabSelection('tab-1', 'op-1', guest)

      const handler = guestOnMock.mock.calls.find(
        ([eventName]) => eventName === 'before-input-event'
      )?.[1]
      expect(handler).toBeTypeOf('function')

      const preventDefault = vi.fn()
      handler?.(
        { preventDefault } as never,
        {
          type: 'keyDown',
          meta: false,
          control: false,
          shift: false,
          alt: false,
          key: 's'
        } as never
      )

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(rendererSendMock).toHaveBeenCalledWith('browser:grabActionShortcut', {
        browserPageId: 'tab-1',
        key: 's'
      })
    })
  })

  describe('guest app shortcut forwarding', () => {
    it('forwards Cmd/Ctrl+Shift+B to the renderer and prevents the guest default', () => {
      const handlers = guestOnMock.mock.calls
        .filter(([eventName]) => eventName === 'before-input-event')
        .map(([, handler]) => handler)
      const forwardingHandler = handlers[1]
      expect(forwardingHandler).toBeTypeOf('function')

      const preventDefault = vi.fn()
      forwardingHandler?.(
        { preventDefault } as never,
        {
          type: 'keyDown',
          meta: process.platform === 'darwin',
          control: process.platform !== 'darwin',
          shift: true,
          alt: false,
          code: 'KeyB',
          key: 'B'
        } as never
      )

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(rendererSendMock).toHaveBeenCalledWith('ui:newBrowserTab')
    })
  })
})
