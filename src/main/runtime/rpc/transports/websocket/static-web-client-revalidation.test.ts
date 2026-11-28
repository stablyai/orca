import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

const FIXED_MTIME = new Date('2024-01-02T03:04:05Z')
const FIXED_LAST_MODIFIED = 'Tue, 02 Jan 2024 03:04:05 GMT'

let root: string
const servers: Server[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-static-web-revalidation-'))
  mkdirSync(join(root, 'assets'))
  mkdirSync(join(root, 'wasm'))
  writeFileSync(join(root, 'web-index.html'), '<html>web index body</html>')
  writeFileSync(join(root, 'assets', 'app.js'), 'bundled asset body')
  writeFileSync(join(root, 'wasm', 'viewer.wasm'), 'wasm module body')
  for (const file of ['web-index.html', 'assets/app.js', 'wasm/viewer.wasm']) {
    utimesSync(join(root, file), FIXED_MTIME, FIXED_MTIME)
  }
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

it('answers no-cache files with a strong etag and last-modified', async () => {
  const endpoint = await serve()
  for (const path of ['/web-index.html', '/wasm/viewer.wasm']) {
    const response = await fetch(`${endpoint}${path}`)
    expect(response.status, path).toBe(200)
    expect(response.headers.get('cache-control'), path).toBe('no-cache')
    expect(response.headers.get('etag'), path).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
    expect(response.headers.get('last-modified'), path).toBe(FIXED_LAST_MODIFIED)
    await response.text()
  }
})

it('keeps /assets/ immutable without validators', async () => {
  const endpoint = await serve()
  const response = await fetch(`${endpoint}/assets/app.js`)
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(response.headers.get('etag')).toBeNull()
  expect(response.headers.get('last-modified')).toBeNull()
  await response.text()
})

it('replies 304 with no body when if-none-match holds', async () => {
  const endpoint = await serve()
  const etag = (await fetch(`${endpoint}/wasm/viewer.wasm`)).headers.get('etag')
  for (const candidate of [etag, `W/${etag}`, `${etag}, "other-tag"`, '*']) {
    const response = await fetch(`${endpoint}/wasm/viewer.wasm`, {
      headers: { 'if-none-match': String(candidate) }
    })
    expect(response.status, String(candidate)).toBe(304)
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('last-modified')).toBe(FIXED_LAST_MODIFIED)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toBe('')
  }
})

it('serves a full 200 when if-none-match does not hold', async () => {
  const endpoint = await serve()
  const response = await fetch(`${endpoint}/wasm/viewer.wasm`, {
    headers: { 'if-none-match': '"stale-tag", "other-stale"' }
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('wasm module body')
})

it('revalidates on if-modified-since only when if-none-match is absent', async () => {
  const endpoint = await serve()
  const path = '/wasm/viewer.wasm'
  const exact = await fetch(`${endpoint}${path}`, {
    headers: { 'if-modified-since': FIXED_LAST_MODIFIED }
  })
  expect(exact.status).toBe(304)
  const stale = await fetch(`${endpoint}${path}`, {
    headers: { 'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT' }
  })
  expect(stale.status).toBe(200)
  await stale.text()
  // A losing if-none-match still wins over a passing if-modified-since.
  const precedence = await fetch(`${endpoint}${path}`, {
    headers: {
      'if-none-match': '"stale-tag"',
      'if-modified-since': FIXED_LAST_MODIFIED
    }
  })
  expect(precedence.status).toBe(200)
  await precedence.text()
})

it('returns a new etag after the file changes, and answers 304 for HEAD too', async () => {
  const endpoint = await serve()
  const first = await fetch(`${endpoint}/web-index.html`)
  const etag = first.headers.get('etag')
  await first.text()

  const again = await fetch(`${endpoint}/web-index.html`)
  expect(again.headers.get('etag')).toBe(etag)
  await again.text()

  writeFileSync(join(root, 'web-index.html'), '<html>web index body, edited</html>')
  const changed = await fetch(`${endpoint}/web-index.html`, {
    headers: { 'if-none-match': String(etag) }
  })
  expect(changed.status).toBe(200)
  expect(changed.headers.get('etag')).not.toBe(etag)
  const next = changed.headers.get('etag')
  await changed.text()

  const head = await fetch(`${endpoint}/web-index.html`, {
    method: 'HEAD',
    headers: { 'if-none-match': String(next) }
  })
  expect(head.status).toBe(304)
  expect(await head.text()).toBe('')
})
