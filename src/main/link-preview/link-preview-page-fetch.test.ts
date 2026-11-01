import http from 'node:http'
import type { LookupFunction } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchLinkPreviewResource,
  type LinkPreviewResourceRequest
} from './link-preview-page-fetch'

const servers: http.Server[] = []

// The production lookup refuses loopback, so tests name a public-looking host and route it here.
const toLoopback: LookupFunction = (_hostname, options, callback) => {
  if (options.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
  } else {
    callback(null, '127.0.0.1', 4)
  }
}

function pageRequest(maxBytes = 64 * 1024): LinkPreviewResourceRequest {
  return {
    kind: 'page',
    mimeTypes: new Set(['text/html']),
    maxBytes,
    signal: AbortSignal.timeout(2_000),
    lookup: toLoopback
  }
}

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
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('fetchLinkPreviewResource', () => {
  it.each(['127.0.0.1', 'localhost'])('never follows a redirect to %s', async (blockedHost) => {
    let reachedSecret = false
    const port = await serve((request, response) => {
      if (request.url === '/secret') {
        reachedSecret = true
        response.writeHead(200, { 'content-type': 'text/html' }).end('<title>secret</title>')
        return
      }
      response.writeHead(302, { location: `http://${blockedHost}:${port}/secret` }).end()
    })

    await expect(
      fetchLinkPreviewResource(`http://site.test:${port}/`, pageRequest())
    ).resolves.toBeNull()
    expect(reachedSecret).toBe(false)
  })

  it('stops reading at </head> without waiting for the rest of the page', async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<html><head><title>Fast</title></HEAD ><body>')
      // The response never ends; only the early stop can settle before the deadline.
    })

    const page = await fetchLinkPreviewResource(`http://site.test:${port}/`, pageRequest())
    expect(page?.body.toString()).toContain('<title>Fast</title>')
  })

  it('keeps a page up to the size cap but drops an oversized image', async () => {
    const port = await serve((request, response) => {
      const type = request.url === '/image' ? 'image/png' : 'text/html'
      response.writeHead(200, { 'content-type': type })
      response.end(Buffer.alloc(4096, 'a'))
    })

    const page = await fetchLinkPreviewResource(`http://site.test:${port}/`, pageRequest(1000))
    expect(page?.body.length).toBe(1000)
    await expect(
      fetchLinkPreviewResource(`http://site.test:${port}/image`, {
        ...pageRequest(1000),
        kind: 'image',
        mimeTypes: new Set(['image/png'])
      })
    ).resolves.toBeNull()
  })
})
