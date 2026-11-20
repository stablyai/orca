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

  it('supports streamed Page.printToPDF results for Playwright page.pdf', async () => {
    mock.webContents.printToPDF.mockResolvedValueOnce(Buffer.from('abcdef'))
    const client = await connect(endpoint)

    const printResponse = await sendAndReceive(client, {
      id: 21,
      method: 'Page.printToPDF',
      params: { transferMode: 'ReturnAsStream' }
    })
    const handle = expectPdfStreamHandle(printResponse)

    const firstRead = await sendAndReceive(client, {
      id: 22,
      method: 'IO.read',
      params: { handle, size: 2 }
    })
    const secondRead = await sendAndReceive(client, {
      id: 23,
      method: 'IO.read',
      params: { handle }
    })
    const closeResponse = await sendAndReceive(client, {
      id: 24,
      method: 'IO.close',
      params: { handle }
    })
    const readAfterClose = await sendAndReceive(client, {
      id: 25,
      method: 'IO.read',
      params: { handle }
    })

    expect(firstRead).toEqual({
      id: 22,
      result: { base64Encoded: true, data: Buffer.from('ab').toString('base64'), eof: false }
    })
    expect(secondRead).toEqual({
      id: 23,
      result: { base64Encoded: true, data: Buffer.from('cdef').toString('base64'), eof: true }
    })
    expect(closeResponse).toEqual({ id: 24, result: {} })
    expect(readAfterClose).toEqual({
      id: 25,
      error: { code: -32000, message: 'Invalid stream handle' }
    })
    client.close()
  })

  it('delivers screencast frames to the session that started the screencast', async () => {
    const client = await connect(endpoint)
    await attachPageSession(client, 1)
    await attachPageSession(client, 2)
    await sendAndReceive(client, {
      id: 3,
      method: 'Page.startScreencast',
      params: { format: 'jpeg' },
      sessionId: 'orca-proxy-session-2'
    })

    const frame = nextMessage(client)
    mock.emit('message', {}, 'Page.screencastFrame', { data: 'jpeg', sessionId: 1 }, '')
    const frameEvent = await frame
    const load = nextMessage(client)
    mock.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 }, '')
    const loadEvent = await load

    expect(frameEvent).toEqual({
      method: 'Page.screencastFrame',
      params: { data: 'jpeg', sessionId: 1 },
      sessionId: 'orca-proxy-session-2'
    })
    expect(loadEvent).toEqual({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
      sessionId: 'orca-proxy-session'
    })
    client.close()
  })

  it('keeps the guest painting from screencast start until stop', async () => {
    const client = await connect(endpoint)
    await attachPageSession(client, 1)

    await sendAndReceive(client, {
      id: 2,
      method: 'Page.startScreencast',
      params: {},
      sessionId: 'orca-proxy-session'
    })
    const releasedWhileStreaming = releasePaint.mock.calls.length
    await sendAndReceive(client, {
      id: 3,
      method: 'Page.stopScreencast',
      sessionId: 'orca-proxy-session'
    })

    expect(holdPaint).toHaveBeenCalledTimes(1)
    expect(releasedWhileStreaming).toBe(0)
    expect(releasePaint).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('releases the screencast paint hold when the guest rejects the start', async () => {
    const client = await connect(endpoint)
    await attachPageSession(client, 1)
    mock.webContents.debugger.sendCommand.mockRejectedValueOnce(new Error('start failed'))

    const response = await sendAndReceive(client, {
      id: 2,
      method: 'Page.startScreencast',
      params: {},
      sessionId: 'orca-proxy-session'
    })

    expect(response.error).toBeDefined()
    expect(releasePaint).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('releases the screencast paint hold when its session detaches', async () => {
    const client = await connect(endpoint)
    await attachPageSession(client, 1)
    await attachPageSession(client, 2)
    await sendAndReceive(client, {
      id: 3,
      method: 'Page.startScreencast',
      params: {},
      sessionId: 'orca-proxy-session-2'
    })

    await sendAndReceive(client, {
      id: 4,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'orca-proxy-session' }
    })
    const releasedAfterOtherDetach = releasePaint.mock.calls.length
    await sendAndReceive(client, {
      id: 5,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'orca-proxy-session-2' }
    })

    expect(releasedAfterOtherDetach).toBe(0)
    expect(releasePaint).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('releases the screencast paint hold when the proxy stops', async () => {
    const client = await connect(endpoint)
    await attachPageSession(client, 1)
    await sendAndReceive(client, {
      id: 2,
      method: 'Page.startScreencast',
      params: {},
      sessionId: 'orca-proxy-session'
    })

    await proxy.stop()

    expect(releasePaint).toHaveBeenCalledTimes(1)
    client.close()
  })
})
