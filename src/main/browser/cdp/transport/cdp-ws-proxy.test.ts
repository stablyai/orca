import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
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

  beforeEach(async () => {
    mock = createMockWebContents()
    proxy = new CdpWsProxy(mockAsWebContents(mock), () => () => {})
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  function expectPdfStreamHandle(response: Record<string, unknown>): string {
    const result = response.result as Record<string, unknown>
    expect(result.data).toBe('')
    expect(result.stream).toEqual(expect.stringMatching(/^orca-pdf-[\da-f-]{36}-\d+$/))
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

    expect(printResponse.id).toBe(21)
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
})
