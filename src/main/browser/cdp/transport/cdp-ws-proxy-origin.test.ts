import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request } from 'node:http'
import WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  sendAndReceive,
  mockAsWebContents,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

function rejectedUpgradeStatus(endpoint: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { headers })
    ws.on('open', () => {
      ws.close()
      reject(new Error('handshake was accepted'))
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', () => {})
  })
}

function httpGet(
  port: number,
  path: string,
  host = `127.0.0.1:${port}`
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function httpStatus(port: number, path: string, host: string): Promise<number> {
  return (await httpGet(port, path, host)).status
}

describe('CdpWsProxy loopback request guard', () => {
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

  it('refuses a websocket handshake from a web page origin', async () => {
    await expect(rejectedUpgradeStatus(endpoint, { Origin: 'https://evil.example' })).resolves.toBe(
      403
    )
  })

  it('refuses a websocket handshake carrying a rebound Host', async () => {
    await expect(
      rejectedUpgradeStatus(endpoint, { Host: `evil.example:${proxy.getPort()}` })
    ).resolves.toBe(403)
  })

  it('keeps the automation client connected when a web page tries to take over', async () => {
    const client = await connect(endpoint)
    await rejectedUpgradeStatus(endpoint, { Origin: 'https://evil.example' })

    mock.webContents.debugger.sendCommand.mockResolvedValueOnce({ ok: true })
    const response = await sendAndReceive(client, { id: 7, method: 'DOM.getDocument' })

    expect(response.result).toEqual({ ok: true })
    expect(getSendCommandMethods(mock)).not.toContain('Network.getAllCookies')
    client.close()
  })

  it('refuses discovery requests whose Host is not loopback', async () => {
    const port = proxy.getPort()
    await expect(
      httpStatus(port, `${tokenPath()}/json/version`, `evil.example:${port}`)
    ).resolves.toBe(403)
  })

  it('still answers discovery requests addressed to loopback', async () => {
    const port = proxy.getPort()
    const path = `${tokenPath()}/json/version`
    await expect(httpStatus(port, path, `127.0.0.1:${port}`)).resolves.toBe(200)
    await expect(httpStatus(port, path, `localhost:${port}`)).resolves.toBe(200)
  })

  it('hides discovery and the websocket from local clients without the token', async () => {
    const port = proxy.getPort()
    const wrongToken = `/${'0'.repeat(64)}`
    for (const path of ['/json/version', '/json/list', `${wrongToken}/json/version`, '/']) {
      await expect(httpGet(port, path)).resolves.toEqual({ status: 404, body: '' })
    }
    await expect(rejectedUpgradeStatus(`ws://127.0.0.1:${port}`, {})).resolves.toBe(404)
    await expect(rejectedUpgradeStatus(`ws://127.0.0.1:${port}${wrongToken}`, {})).resolves.toBe(
      404
    )
    await expect(
      rejectedUpgradeStatus(`ws://127.0.0.1:${port}/devtools/browser`, {})
    ).resolves.toBe(404)
  })

  it('accepts the token and returns it in discovered websocket URLs', async () => {
    const port = proxy.getPort()
    const version = await httpGet(port, `${tokenPath()}/json/version`)
    expect(JSON.parse(version.body).webSocketDebuggerUrl).toBe(endpoint)
    const list = await httpGet(port, `${tokenPath()}/json/list`)
    expect(JSON.parse(list.body)[0].webSocketDebuggerUrl).toBe(endpoint)

    const client = await connect(endpoint)
    mock.webContents.debugger.sendCommand.mockResolvedValueOnce({ ok: true })
    await expect(sendAndReceive(client, { id: 1, method: 'DOM.getDocument' })).resolves.toEqual(
      expect.objectContaining({ result: { ok: true } })
    )
    client.close()
  })

  function tokenPath(): string {
    return new URL(endpoint).pathname
  }
})
