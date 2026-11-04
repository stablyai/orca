import { describe, it, expect, vi } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  mockAsWebContents,
  sendAndReceive
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

describe('CdpWsProxy first-paint gate', () => {
  it('lets an unpainted page paint before input reaches it, once per document', async () => {
    const guest = createMockWebContents()
    guest.webContents.getType.mockReturnValue('webview')
    let paintFrame = (): void => {}
    // A blank document: frames run, but no paint entry is ever recorded.
    guest.webContents.debugger.sendCommand.mockImplementation(
      async (method?: string, params?: Record<string, unknown>) => {
        if (method !== 'Runtime.evaluate') {
          return {}
        }
        if (params?.returnByValue) {
          return { result: { value: [false, 1234.5] } }
        }
        await new Promise<void>((resolve) => {
          paintFrame = resolve
        })
        return {}
      }
    )
    const releasePaint = vi.fn()
    const holdPaint = vi.fn(() => releasePaint)
    const guestProxy = new CdpWsProxy(mockAsWebContents(guest), holdPaint)
    const client = await connect(await guestProxy.start())
    const move = (id: number): Promise<Record<string, unknown>> =>
      sendAndReceive(client, {
        id,
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: 1, y: 1 }
      })

    const first = move(33)
    await vi.waitFor(() => expect(holdPaint).toHaveBeenCalledTimes(1))
    expect(getSendCommandMethods(guest)).not.toContain('Input.dispatchMouseEvent')
    paintFrame()
    await first
    await move(34)

    expect(getSendCommandMethods(guest).filter((m) => m.startsWith('Input.'))).toHaveLength(2)
    expect(holdPaint).toHaveBeenCalledTimes(1)
    expect(releasePaint).toHaveBeenCalledTimes(1)
    client.close()
    await guestProxy.stop()
  })
})
