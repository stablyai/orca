import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeWorkspacePortPage } from './workspace-port-page-probe'

const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
const servers: http.Server[] = []

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server')
  }
  return address.port
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

describe('probeWorkspacePortPage', () => {
  it('reads the title and linked icon of a page a dev server serves', async () => {
    const port = await serve((request, response) => {
      if (request.url === '/assets/icon.svg') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(ICON)
        return
      }
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<html><head><title>\n  Vite &amp; React </title><link rel="shortcut icon" href="/assets/icon.svg"></head></html>'
        )
    })

    await expect(
      probeWorkspacePortPage({ host: 'localhost', port, protocol: 'http' })
    ).resolves.toEqual({
      kind: 'page',
      title: 'Vite & React',
      faviconDataUrl: `data:image/svg+xml;base64,${ICON.toString('base64')}`
    })
  })

  it('follows a same-origin redirect to the page', async () => {
    const port = await serve((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { location: '/login' }).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Sign in</title>')
    })

    await expect(
      probeWorkspacePortPage({ host: '127.0.0.1', port, protocol: 'http' })
    ).resolves.toMatchObject({ kind: 'page', title: 'Sign in', faviconDataUrl: null })
  })

  it.each([
    ['unclosed links', `<title>ok</title>${'<link '.repeat(32_000)}`, 'ok'],
    ['unclosed titles', '<title>'.repeat(27_000), null]
  ])('parses a page of %s without stalling the event loop', async (_name, page, title) => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end(page)
    })

    const startedAt = performance.now()
    await expect(
      probeWorkspacePortPage({ host: 'localhost', port, protocol: 'http' })
    ).resolves.toEqual({ kind: 'page', title, faviconDataUrl: null })
    // Rescanning the body from each unclosed opener took seconds on this ~190 KB page.
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  it('leaves out APIs and error pages', async () => {
    const api = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    const notFound = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' }).end('Cannot GET /')
    })

    for (const port of [api, notFound]) {
      await expect(
        probeWorkspacePortPage({ host: 'localhost', port, protocol: 'http' })
      ).resolves.toEqual({ kind: 'not-page' })
    }
  })

  it('never reaches past loopback', async () => {
    let requested = false
    const port = await serve((_request, response) => {
      requested = true
      response.writeHead(200, { 'content-type': 'text/html' }).end('<title>x</title>')
    })

    await expect(
      probeWorkspacePortPage({ host: 'example.com', port, protocol: 'http' })
    ).resolves.toEqual({ kind: 'not-page' })
    expect(requested).toBe(false)
  })
})
