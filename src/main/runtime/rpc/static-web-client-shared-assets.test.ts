import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-shared-static-'))
  roots.push(root)
  const renderer = join(root, 'renderer')
  const files = [
    'web-index.html',
    'assets/shared.js',
    'assets/editor.worker.js',
    'cmaps/Font.bcmap',
    'standard_fonts/Font.pfb',
    'wasm/viewer.wasm'
  ]
  for (const file of [
    ...files,
    'index.html',
    'popout.html',
    'space.html',
    'assets/desktop.js',
    'assets/shared.js.map'
  ]) {
    mkdirSync(dirname(join(renderer, file)), { recursive: true })
    writeFileSync(join(renderer, file), file)
  }
  writeFileSync(join(renderer, '.orca-web-client-files.json'), JSON.stringify(files))
  return { renderer, files }
}
async function serve(root: string) {
  const server = createServer(createStaticWebClientHandler(root))
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No address')
  }
  return `http://127.0.0.1:${address.port}`
}
it('serves only the web closure at root and through a reverse proxy, including worker/PDF files', async () => {
  const { renderer, files } = fixture()
  const endpoint = await serve(renderer)
  for (const prefix of ['', '/proxy/orca']) {
    for (const file of files) {
      const response = await fetch(`${endpoint}${prefix}/${file}`)
      expect(response.status, `${prefix}/${file}`).toBe(200)
      expect(await response.text()).toBe(file)
    }
    for (const file of [
      'popout.html',
      'space.html',
      'assets/desktop.js',
      'assets/shared.js.map',
      '.orca-web-client-files.json'
    ]) {
      expect((await fetch(`${endpoint}${prefix}/${file}`)).status, file).toBe(404)
    }
  }
  expect(await (await fetch(endpoint)).text()).toBe('web-index.html')
  const head = await fetch(`${endpoint}/assets/shared.js`, { method: 'HEAD' })
  expect(head.headers.get('content-length')).toBe(String('assets/shared.js'.length))
  expect(await head.text()).toBe('')
})
it('fails closed when a renderer has no manifest or a corrupt manifest', async () => {
  const { renderer } = fixture()
  rmSync(join(renderer, '.orca-web-client-files.json'))
  const endpoint = await serve(renderer)
  expect((await fetch(`${endpoint}/assets/desktop.js`)).status).toBe(404)
})
it('disables only the browser client when the manifest is truncated or invalid', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    for (const manifest of ['{', JSON.stringify(['../index.html'])]) {
      const { renderer } = fixture()
      writeFileSync(join(renderer, '.orca-web-client-files.json'), manifest)
      const endpoint = await serve(renderer)
      for (const file of ['', 'web-index.html', 'assets/shared.js', 'assets/desktop.js']) {
        expect((await fetch(`${endpoint}/${file}`)).status, file).toBe(404)
      }
    }
    expect(warn).toHaveBeenCalledTimes(2)
  } finally {
    warn.mockRestore()
  }
})
