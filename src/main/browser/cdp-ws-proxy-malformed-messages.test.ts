import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandCalls,
  getSendCommandMethods,
  mockAsWebContents,
  sendAndReceive,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))

function nextMessage(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    client.once('message', (data) => resolve(JSON.parse(data.toString())))
  })
}

describe('CdpWsProxy malformed client messages', () => {
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

  it.each([
    '{"id":1,"method":42}',
    '{"id":1,"method":"DOM.enable","params":[]}',
    '{"id":1,"method":"DOM.enable","sessionId":42}'
  ])('answers malformed command %s with an error and keeps the client usable', async (raw) => {
    const client = await connect(endpoint)
    try {
      const reply = nextMessage(client)
      client.send(raw)
      expect(await reply).toEqual({
        id: 1,
        error: { code: -32000, message: 'Invalid CDP request' }
      })
      expect(getSendCommandMethods(mock)).not.toContain('DOM.enable')

      const next = await sendAndReceive(client, { id: 2, method: 'Browser.getVersion' })
      expect(next).toMatchObject({ id: 2, result: expect.any(Object) })
    } finally {
      client.close()
    }
  })

  it.each(['"params":null', '"sessionId":null'])('treats %s as absent', async (field) => {
    mock.webContents.debugger.sendCommand.mockResolvedValueOnce({})
    const client = await connect(endpoint)
    try {
      const reply = nextMessage(client)
      client.send(`{"id":1,"method":"DOM.enable",${field}}`)
      expect(await reply).toEqual({ id: 1, result: {} })
      expect(getSendCommandCalls(mock)).toContainEqual(['DOM.enable', {}])
    } finally {
      client.close()
    }
  })

  it('contains an invalid UTF-8 frame and serves the next client', async () => {
    const malformed = await connect(endpoint)
    const closed = once(malformed, 'close')
    malformed.send(Buffer.from([0xff]), { binary: false })
    await closed

    const next = await connect(endpoint)
    try {
      expect(await sendAndReceive(next, { id: 1, method: 'Browser.getVersion' })).toMatchObject({
        id: 1,
        result: expect.any(Object)
      })
    } finally {
      next.close()
    }
  })
})
