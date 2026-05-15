import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketTransport } from './ws-transport'

describe('WebSocketTransport static web client', () => {
  const transports: WebSocketTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
  })

  function createStaticTransport(staticRoot: string): WebSocketTransport {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      staticRoot
    })
    transports.push(transport)
    return transport
  }

  it('serves the built web client from the same server', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'web-index.html'), '<html>web</html>')
    writeFileSync(join(staticRoot, 'assets', 'app.js'), 'console.log("web")')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const indexResponse = await fetch(`http://127.0.0.1:${transport.resolvedPort}/web-index.html`)
    expect(indexResponse.status).toBe(200)
    expect(indexResponse.headers.get('content-type')).toContain('text/html')
    await expect(indexResponse.text()).resolves.toBe('<html>web</html>')

    const assetResponse = await fetch(`http://127.0.0.1:${transport.resolvedPort}/assets/app.js`)
    expect(assetResponse.status).toBe(200)
    expect(assetResponse.headers.get('cache-control')).toContain('immutable')
    await expect(assetResponse.text()).resolves.toBe('console.log("web")')
  })

  it('serves web assets when a reverse-proxy path prefix is forwarded', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'web-index.html'), '<script src="./assets/app.js"></script>')
    writeFileSync(join(staticRoot, 'assets', 'app.js'), 'console.log("prefixed")')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const indexResponse = await fetch(
      `http://127.0.0.1:${transport.resolvedPort}/orca/web-index.html`
    )
    expect(indexResponse.status).toBe(200)
    await expect(indexResponse.text()).resolves.toBe('<script src="./assets/app.js"></script>')

    const assetResponse = await fetch(
      `http://127.0.0.1:${transport.resolvedPort}/orca/assets/app.js`
    )
    expect(assetResponse.status).toBe(200)
    await expect(assetResponse.text()).resolves.toBe('console.log("prefixed")')
  })

  it('does not expose arbitrary files from the static root', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    writeFileSync(join(staticRoot, 'package.json'), '{}')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const response = await fetch(`http://127.0.0.1:${transport.resolvedPort}/package.json`)
    expect(response.status).toBe(404)
  })

  it('rejects encoded Windows separators in static paths', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'package.json'), '{}')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const response = await fetch(
      `http://127.0.0.1:${transport.resolvedPort}/assets/..%5Cpackage.json`
    )
    expect(response.status).toBe(400)
  })
})
