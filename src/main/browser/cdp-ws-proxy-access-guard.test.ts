import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request } from 'node:http'
import WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  sendAndReceive,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

// Why: the proxy forwards arbitrary CDP methods to a live, logged-in browser tab, so the
// upgrade and the discovery endpoints are the whole trust boundary. These pin the two
// checks a browser cannot forge: it always sends Origin, and DNS rebinding always leaves
// the attacker's hostname in Host.
describe('CdpWsProxy access guard', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string
  let port: number

  beforeEach(async () => {
    mock = createMockWebContents()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxy = new CdpWsProxy(mock.webContents as any)
    endpoint = await proxy.start()
    port = proxy.getPort()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  function connectFailure(url: string, options?: WebSocket.ClientOptions): Promise<Error> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options)
      ws.on('error', (error) => resolve(error))
      ws.on('open', () => {
        ws.close()
        reject(new Error('upgrade unexpectedly succeeded'))
      })
    })
  }

  // Why: fetch() silently drops a caller-supplied Host (forbidden header name), which would
  // make the rebinding cases pass vacuously. node:http sends the header verbatim.
  function httpStatus(path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('rejects a websocket upgrade that carries a browser Origin', async () => {
    const error = await connectFailure(endpoint, { origin: 'https://evil.example' })

    expect(error.message).toContain('403')
    expect(getSendCommandMethods(mock)).not.toContain('Runtime.evaluate')
  })

  it('rejects an upgrade carrying an empty Origin header', async () => {
    // Presence is the signal, not content: a CDP client sends no Origin at all.
    const error = await connectFailure(endpoint, { headers: { origin: '' } })

    expect(error.message).toContain('403')
  })

  it('rejects an upgrade from an opaque origin', async () => {
    // Sandboxed iframes and data: URLs send the literal string "null".
    const error = await connectFailure(endpoint, { headers: { origin: 'null' } })

    expect(error.message).toContain('403')
  })

  it('rejects discovery requests carrying an empty Origin header', async () => {
    await expect(httpStatus('/json/version', { origin: '' })).resolves.toBe(403)
  })

  it('rejects a websocket upgrade whose Host is not the bound loopback port', async () => {
    // A DNS-rebound page connects to 127.0.0.1 but still names the attacker's host.
    const error = await connectFailure(endpoint, { headers: { host: `rebind.evil:${port}` } })

    expect(error.message).toContain('403')
  })

  it('rejects a websocket upgrade whose Host names a different port', async () => {
    const error = await connectFailure(endpoint, { headers: { host: `127.0.0.1:${port + 1}` } })

    expect(error.message).toContain('403')
  })

  it('rejects discovery requests that carry a browser Origin', async () => {
    await expect(httpStatus('/json/version', { origin: 'https://evil.example' })).resolves.toBe(403)
    await expect(httpStatus('/json/list', { origin: 'https://evil.example' })).resolves.toBe(403)
  })

  it('rejects discovery requests from a rebound hostname', async () => {
    // Same-origin fetches send no Origin after rebinding, so Host carries this case.
    await expect(httpStatus('/json/version', { host: `rebind.evil:${port}` })).resolves.toBe(403)
  })

  it('still serves a local CDP client that sends no Origin', async () => {
    const ws = await connect(endpoint)

    const response = await sendAndReceive(ws, { id: 1, method: 'Runtime.evaluate', params: {} })

    expect(response.id).toBe(1)
    expect(getSendCommandMethods(mock)).toContain('Runtime.evaluate')
    ws.close()
  })

  it('still serves discovery to a local CDP client on either loopback name', async () => {
    await expect(httpStatus('/json/version', {})).resolves.toBe(200)
    await expect(httpStatus('/json/list', { host: `localhost:${port}` })).resolves.toBe(200)
  })

  it('keeps the agent client connected when a rejected upgrade arrives', async () => {
    const ws = await connect(endpoint)

    await expect(connectFailure(endpoint, { origin: 'https://evil.example' })).resolves.toBeTruthy()

    // Regression: an accepted connection evicts the incumbent client, so a rejected
    // upgrade must not reach that path or any web page could kill agent automation.
    expect(ws.readyState).toBe(WebSocket.OPEN)
    const response = await sendAndReceive(ws, { id: 2, method: 'Page.enable', params: {} })
    expect(response.id).toBe(2)
    ws.close()
  })
})
