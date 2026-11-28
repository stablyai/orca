import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

const COMPRESSIBLE = 'const value = "a compressible static asset body";\n'
const compressible = (length: number): Buffer =>
  Buffer.from(COMPRESSIBLE.repeat(Math.ceil(length / COMPRESSIBLE.length)))

/** Deterministic pseudo-random bytes that no encoder shrinks; keeps the keep-if-smaller test stable. */
function denseBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  let seed = 0x9e3779b9
  for (let index = 0; index < length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    bytes[index] = (seed >>> 8) & 0xff
  }
  return bytes
}

let root: string
const servers: Server[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-static-web-compression-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'app.js'), compressible(64 * 1024))
  writeFileSync(join(root, 'assets', 'dense.js'), denseBytes(8 * 1024))
  writeFileSync(join(root, 'assets', 'small.js'), compressible(256))
  writeFileSync(join(root, 'assets', 'logo.png'), compressible(64 * 1024))
  writeFileSync(join(root, 'web-index.html'), compressible(8 * 1024))
})
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  rmSync(root, { recursive: true, force: true })
})

async function serve(): Promise<string> {
  const server = createServer(createStaticWebClientHandler(root))
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing HTTP address')
  }
  return `http://127.0.0.1:${address.port}`
}

it('serves brotli when the client accepts it and the variant is smaller', async () => {
  const endpoint = await serve()
  const source = compressible(64 * 1024)
  const response = await fetch(`${endpoint}/assets/app.js`, {
    headers: { 'accept-encoding': 'gzip, deflate, br' }
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-encoding')).toBe('br')
  expect(response.headers.get('vary')).toBe('Accept-Encoding')
  expect(Number(response.headers.get('content-length'))).toBeLessThan(source.byteLength)
  expect(Buffer.from(await response.arrayBuffer()).equals(source)).toBe(true)
})

it('serves gzip when the client accepts gzip but not br', async () => {
  const endpoint = await serve()
  const response = await fetch(`${endpoint}/assets/app.js`, {
    headers: { 'accept-encoding': 'gzip' }
  })
  expect(response.headers.get('content-encoding')).toBe('gzip')
  expect(Buffer.from(await response.arrayBuffer()).equals(compressible(64 * 1024))).toBe(true)
})

it('prefers br over a higher-q gzip, and lets a wildcard accept it', async () => {
  const endpoint = await serve()
  for (const header of ['gzip;q=1, br;q=0.1', '*', 'br;q=0, *;q=1']) {
    const response = await fetch(`${endpoint}/assets/app.js`, {
      headers: { 'accept-encoding': header }
    })
    expect(response.headers.get('content-encoding'), header).toBe(
      header === 'br;q=0, *;q=1' ? 'gzip' : 'br'
    )
    await response.arrayBuffer()
  }
})

it('serves identity when the client accepts no encoding', async () => {
  const endpoint = await serve()
  const source = compressible(64 * 1024)
  const response = await fetch(`${endpoint}/assets/app.js`, {
    headers: { 'accept-encoding': 'identity' }
  })
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('vary')).toBe('Accept-Encoding')
  expect(response.headers.get('content-length')).toBe(String(source.byteLength))
  expect(Buffer.from(await response.arrayBuffer()).equals(source)).toBe(true)
})

it('returns GET-identical encoded headers for HEAD', async () => {
  const endpoint = await serve()
  const headers = { 'accept-encoding': 'br' }
  const get = await fetch(`${endpoint}/assets/app.js`, { headers })
  const head = await fetch(`${endpoint}/assets/app.js`, { method: 'HEAD', headers })
  expect(head.headers.get('content-encoding')).toBe('br')
  for (const name of ['content-length', 'content-type', 'cache-control', 'vary']) {
    expect(head.headers.get(name), name).toBe(get.headers.get(name))
  }
  expect(Number(head.headers.get('content-length'))).toBeLessThan(64 * 1024)
  expect(await head.text()).toBe('')
  await get.arrayBuffer()
})

it('keeps identity when an encoding would not shrink the body', async () => {
  const endpoint = await serve()
  const response = await fetch(`${endpoint}/assets/dense.js`, {
    headers: { 'accept-encoding': 'br, gzip' }
  })
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('content-length')).toBe(String(8 * 1024))
  expect((await response.arrayBuffer()).byteLength).toBe(8 * 1024)
})

it('keeps identity below the byte floor and for already-dense extensions', async () => {
  const endpoint = await serve()
  for (const path of ['/assets/small.js', '/assets/logo.png']) {
    const response = await fetch(`${endpoint}${path}`, {
      headers: { 'accept-encoding': 'br, gzip' }
    })
    expect(response.headers.get('content-encoding'), path).toBeNull()
    await response.arrayBuffer()
  }
})

it('compresses the index page like any other text asset', async () => {
  const endpoint = await serve()
  const source = compressible(8 * 1024)
  const response = await fetch(`${endpoint}/`, { headers: { 'accept-encoding': 'br' } })
  expect(response.headers.get('content-encoding')).toBe('br')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(Buffer.from(await response.arrayBuffer()).equals(source)).toBe(true)
})
