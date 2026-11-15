import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  nextMessage,
  sendAndReceive,
  mockAsWebContents,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

describe('CdpWsProxy', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string
  let releasePaint: Mock<() => void>
  let holdPaint: Mock<() => () => void>

  beforeEach(async () => {
    mock = createMockWebContents()
    releasePaint = vi.fn()
    holdPaint = vi.fn(() => releasePaint)
    proxy = new CdpWsProxy(mockAsWebContents(mock), holdPaint)
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  async function attachPageSession(client: WebSocket, id: number): Promise<void> {
    await sendAndReceive(client, {
      id,
      method: 'Target.attachToTarget',
      params: { targetId: 'orca-proxy-target', flatten: true }
    })
  }

  function expectPdfStreamHandle(response: Record<string, unknown>): string {
    const result = response.result as Record<string, unknown>
    expect(result.data).toBe('')
    return result.stream as string
  }

  it('publishes safe discovery for a retained private document', async () => {
    mock.webContents.getURL.mockReturnValue('https://kagi.com/search?token=discovery-secret&q=one')
    mock.webContents.getTitle.mockReturnValue(
      'https://kagi.com/search?token=discovery-secret&q=one'
    )
    const client = await connect(endpoint)
    const response = await sendAndReceive(client, { id: 1, method: 'Target.getTargets' })
    expect(response).toMatchObject({
      result: {
        targetInfos: [
          {
            url: 'https://kagi.com/search?q=one',
            title: 'https://kagi.com/search?q=one'
          }
        ]
      }
    })
    expect(JSON.stringify(response)).not.toContain('discovery-secret')
    client.close()
  })
})
