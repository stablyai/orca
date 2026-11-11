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

describe('CdpWsProxy agent input focus guard', () => {
  it('refuses a press when the user’s focus cannot be guarded', async () => {
    const mock = createMockWebContents()
    mock.webContents.getType.mockReturnValue('webview')
    const proxy = new CdpWsProxy(
      mockAsWebContents(mock),
      () => () => {},
      async () => {
        throw new Error('focus guard unavailable')
      }
    )
    const client = await connect(await proxy.start())

    const response = await sendAndReceive(client, {
      id: 81,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 1 }
    })

    expect(response.error).toMatchObject({ message: 'focus guard unavailable' })
    expect(getSendCommandMethods(mock)).not.toContain('Input.dispatchMouseEvent')
    client.close()
    await proxy.stop()
  })
})
