import { EventEmitter } from 'node:events'
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

function createGuest(insertText: (text: string) => Promise<void>) {
  const mock = createMockWebContents()
  mock.webContents.getType.mockReturnValue('webview')
  const events = new EventEmitter()
  Object.assign(mock.webContents, {
    insertText: vi.fn(insertText),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events)
  })
  return { mock, events }
}

describe('guest input route admission', () => {
  it('refuses keys when the focused guest frame cannot be resolved', async () => {
    forceUnknownRoute.enabled = true
    try {
      const { mock } = createGuest(async () => {})
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

  it('refuses text when the root frame probe cannot confirm focus', async () => {
    const insertText = vi.fn(async () => {})
    const { mock } = createGuest(insertText)
    const send = vi.fn(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        throw new Error('probe context destroyed')
      }
      return {}
    })

    await expect(routePageTextInsertion(mockAsWebContents(mock), send)).rejects.toMatchObject({
      code: 'browser_input_target_unavailable'
    })
    expect(insertText).not.toHaveBeenCalled()
    expect(mock.webContents.focus).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
  })

  it('answers when the guest renderer dies during native insertion', async () => {
    const { mock, events } = createGuest(() => new Promise<void>(() => {}))
    const send = vi.fn(async (method: string) =>
      method === 'Runtime.evaluate' ? { result: { type: 'boolean', value: true } } : {}
    )

    const route = await routePageTextInsertion(mockAsWebContents(mock), send)
    const delivered = route.deliver({ text: 'First\nSecond' })
    await vi.waitFor(() => expect(events.listenerCount('render-process-gone')).toBe(1))
    events.emit('render-process-gone')

    await expect(delivered).rejects.toMatchObject({ code: 'browser_error' })
    expect(events.listenerCount('render-process-gone')).toBe(0)
    expect(events.listenerCount('destroyed')).toBe(0)
  })
})
