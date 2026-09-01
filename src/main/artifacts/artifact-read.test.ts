import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_CLI_MAX_READ_BYTES } from '../../shared/artifacts'
import { parseTarget, readArtifactContent } from './artifact-read'

const metadata = {
  artifact: {
    version: 1,
    slug: 'abc123',
    title: null,
    originalFileName: 'notes.md',
    sourceContentType: 'text/markdown',
    renderedContentType: 'text/html',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    byteSize: 18,
    deletedAt: null
  },
  shareUrl: 'http://127.0.0.1/a/abc123'
}

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  server = undefined
})

async function serve(
  routes: Record<string, { body: string; type: string; status?: number }>
): Promise<string> {
  server = createServer((request, response) => {
    const route = routes[request.url ?? '']
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(route.status ?? 200, { 'content-type': route.type })
    response.end(route.body)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind')
  }
  return `http://127.0.0.1:${address.port}`
}

describe('readArtifactContent', () => {
  it('reads rendered HTML from a public share wrapper and keeps scripts inert', async () => {
    const api = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'application/json' },
      '/a/abc123': { body: '<iframe src="/usercontent/abc123/artifact.html">', type: 'text/html' },
      '/usercontent/abc123/artifact.html': {
        body: '<script>alert(1)</script><h1>Hello</h1>',
        type: 'text/html'
      }
    })
    const result = await readArtifactContent('abc123', { apiUrl: api })
    expect(result.content).toContain('<script>alert(1)</script>')
    expect(result.contentType).toBe('text/html')
  })

  it('uses the canonical share host for bare ids with a non-loopback API', () => {
    expect(parseTarget('abc123', 'https://api.onorca.dev')).toEqual({
      id: 'abc123',
      shareUrl: 'https://share.onorca.dev/a/abc123'
    })
  })

  it('reports the content response type', async () => {
    const api = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'application/json' },
      '/a/abc123': { body: '<iframe src="/usercontent/abc123/artifact.html">', type: 'text/html' },
      '/usercontent/abc123/artifact.html': { body: '# Hello', type: 'text/markdown' }
    })
    const result = await readArtifactContent('abc123', { apiUrl: api })
    expect(result.contentType).toBe('text/markdown')
    expect(result.content).toBe('# Hello')
  })

  it('rejects malformed wrappers and oversized content', async () => {
    const api = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'application/json' },
      '/a/abc123': { body: '<p>no frame</p>', type: 'text/html' }
    })
    await expect(readArtifactContent('abc123', { apiUrl: api })).rejects.toThrow(
      /exactly one content frame/
    )
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    const oversized = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'application/json' },
      '/a/abc123': { body: '<iframe src="/usercontent/abc123/artifact.html">', type: 'text/html' },
      '/usercontent/abc123/artifact.html': {
        body: 'x'.repeat(ARTIFACT_CLI_MAX_READ_BYTES + 1),
        type: 'text/html'
      }
    })
    await expect(readArtifactContent('abc123', { apiUrl: oversized })).rejects.toThrow(/size limit/)
  })

  it('rejects unsupported content types and malformed ids before unsafe fetches', async () => {
    const api = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'text/plain' }
    })
    await expect(readArtifactContent('../health', { apiUrl: api })).rejects.toThrow(/id is invalid/)
    await expect(readArtifactContent('abc123', { apiUrl: api })).rejects.toThrow(/content type/)
  })

  it('rejects a content frame on an untrusted host', async () => {
    const api = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'application/json' },
      '/a/abc123': {
        body: '<iframe src="https://evil.example/usercontent/abc123/artifact.html">',
        type: 'text/html'
      }
    })
    await expect(readArtifactContent('abc123', { apiUrl: api })).rejects.toThrow(
      /allowed Orca content URL/
    )
  })

  it('rejects noncanonical ports on the trusted content host', async () => {
    const api = await serve({
      '/v1/artifacts/abc123': { body: JSON.stringify(metadata), type: 'application/json' },
      '/a/abc123': {
        body: '<iframe src="https://content.orcausercontent.dev:444/usercontent/abc123/artifact.html">',
        type: 'text/html'
      }
    })
    await expect(readArtifactContent('abc123', { apiUrl: api })).rejects.toThrow(
      /allowed Orca content URL/
    )
  })
})
