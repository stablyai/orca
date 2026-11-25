import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeMobileWebBundleId } from '../../../../../shared/mobile-web-bundle/manifest-contract'
import { createStaticWebClientHandler } from './static-web-client-handler'

const INDEX = '<!doctype html><div id="root"></div>'
const LISTED_ASSET = 'console.log(1)'

describe('static handler serving the phone page to browsers', () => {
  let root: string
  let server: Server
  let base: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-mobile-web-'))
    const mobile = join(root, 'mobile-web')
    mkdirSync(join(mobile, 'assets'), { recursive: true })
    writeFileSync(join(mobile, 'index.html'), INDEX)
    writeFileSync(join(mobile, 'assets', 'aaaaaaaaaaaaaaaa.js'), LISTED_ASSET)
    writeFileSync(join(mobile, 'assets', 'unlisted.js'), 'secret')
    writeFileSync(join(root, 'outside.txt'), 'outside')
    const assets = [
      {
        path: 'assets/aaaaaaaaaaaaaaaa.js',
        sha256: '0'.repeat(64),
        byteLength: LISTED_ASSET.length,
        contentType: 'text/javascript; charset=utf-8'
      },
      {
        path: 'index.html',
        sha256: '1'.repeat(64),
        byteLength: INDEX.length,
        contentType: 'text/html; charset=utf-8'
      }
    ]
    writeFileSync(
      join(mobile, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        buildId: computeMobileWebBundleId(assets),
        desktopVersion: '0.0.0',
        minCompatibleRuntimeProtocolVersion: 0,
        runtimeProtocolVersion: 0,
        entrypoint: 'index.html',
        totalBytes: LISTED_ASSET.length + INDEX.length,
        assets,
        routes: []
      })
    )
    server = createServer(createStaticWebClientHandler(undefined, async () => mobile))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP listener')
    }
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  const get = async (path: string) => {
    const response = await fetch(base + path)
    return { status: response.status, body: await response.text() }
  }

  it('serves only the entry, the manifest and assets the manifest lists', async () => {
    expect(await get('/mobile-web')).toEqual({ status: 200, body: INDEX })
    expect(await get('/h/web/session/wt-1')).toEqual({ status: 200, body: INDEX })
    expect((await get('/mobile-web/manifest.json')).status).toBe(200)
    expect(await get('/assets/aaaaaaaaaaaaaaaa.js')).toEqual({ status: 200, body: LISTED_ASSET })

    expect((await get('/assets/unlisted.js')).status).toBe(404)
    expect((await get('/mobile-web/index.html')).status).toBe(404)
    expect((await get('/assets/..%2Foutside.txt')).status).toBe(400)
    expect((await get('/assets/../../outside.txt')).status).toBe(404)
    expect((await get('/outside.txt')).status).toBe(404)
  })
})
