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
  return mock
}

describe('guest input route admission', () => {
  it('refuses keys when the focused guest frame cannot be resolved', async () => {
    forceUnknownRoute.enabled = true
    try {
      const mock = createGuest()
      await expect(
        dispatchPageKeyEvent(
          mockAsWebContents(mock),
          { type: 'keyDown', key: 'a', text: 'a' },
          async () => ({})
        )
      ).rejects.toMatchObject({ code: 'browser_input_target_unavailable' })
    } finally {
      forceUnknownRoute.enabled = false
    }
  })

  it('refuses text when the root frame probe cannot confirm focus', async () => {
    const mock = createGuest()
    const send = vi.fn(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        throw new Error('probe context destroyed')
      }
      return {}
    })

    await expect(routePageTextInsertion(mockAsWebContents(mock), send)).rejects.toMatchObject({
      code: 'browser_input_target_unavailable'
    })
  })
})
