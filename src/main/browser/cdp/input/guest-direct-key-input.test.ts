import { describe, expect, it, vi } from 'vitest'
import { dispatchPageKeyEvent, routePageTextInsertion } from './guest-direct-key-input'
import { createMockWebContents, mockAsWebContents } from '../transport/cdp-ws-proxy-test-harness'
import type * as FocusedFrameRouteModule from './guest-focused-frame-route'

const forceUnknownRoute = vi.hoisted(() => ({ enabled: false }))

vi.mock('./guest-focused-frame-route', async (importActual) => {
  const actual = await importActual<typeof FocusedFrameRouteModule>()
  return {
    resolveFocusedFrameRoute: (...args: Parameters<typeof actual.resolveFocusedFrameRoute>) =>
      forceUnknownRoute.enabled
        ? Promise.resolve({ kind: 'unknown' })
        : actual.resolveFocusedFrameRoute(...args)
  }
})

function createGuest() {
  const mock = createMockWebContents()
  mock.webContents.getType.mockReturnValue('webview')
  const insertText = vi.fn(async (_text: string) => {})
  Object.assign(mock.webContents, { insertText })
  return { mock, insertText }
}

describe('guest input route admission', () => {
  it('refuses keys when the focused guest frame cannot be resolved', async () => {
    forceUnknownRoute.enabled = true
    try {
      const { mock } = createGuest()
      await expect(
        dispatchPageKeyEvent(
          mockAsWebContents(mock),
          { type: 'keyDown', key: 'a', text: 'a' },
          async () => ({})
        )
      ).rejects.toMatchObject({ code: 'browser_input_target_unavailable' })
      expect(mock.webContents.focus).not.toHaveBeenCalled()
    } finally {
      forceUnknownRoute.enabled = false
    }
  })

  it('keeps text on the guest without borrowing focus when the root frame probe fails', async () => {
    const { mock, insertText } = createGuest()
    const send = vi.fn(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        throw new Error('probe context destroyed')
      }
      return {}
    })

    const route = await routePageTextInsertion(mockAsWebContents(mock), send)
    await route.deliver({ text: 'First\nSecond 🙏' })

    expect(insertText).toHaveBeenCalledWith('First\nSecond 🙏')
    expect(mock.webContents.focus).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
  })
})
