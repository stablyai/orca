import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

const PNG_96 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 96, 0, 0, 0, 96])
])

let root: string
let savedIconEnv: string | undefined
const servers: Server[] = []

beforeEach(() => {
  savedIconEnv = process.env.ORCA_WEB_ICON
  delete process.env.ORCA_WEB_ICON
  root = mkdtempSync(join(tmpdir(), 'orca-static-web-branding-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(
    join(root, 'web-index.html'),
    '<!doctype html><html><head><title>Orca Web</title></head><body></body></html>'
  )
})

afterEach(async () => {
  if (savedIconEnv === undefined) {
    delete process.env.ORCA_WEB_ICON
  } else {
    process.env.ORCA_WEB_ICON = savedIconEnv
  }
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  rmSync(root, { recursive: true, force: true })
})

async function startServer(): Promise<string> {
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

it('serves the ORCA_WEB_ICON file and injects icon and manifest links', async () => {
  const iconPath = join(root, 'custom.png')
  writeFileSync(iconPath, PNG_96)
  process.env.ORCA_WEB_ICON = iconPath
  const url = await startServer()

  const html = await (await fetch(`${url}/`)).text()
  expect(html).toContain('<link rel="icon" type="image/png" href="./orca-web-icon">')
  expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest">')

  const iconResponse = await fetch(`${url}/orca-web-icon`)
  expect(iconResponse.status).toBe(200)
  expect(iconResponse.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await iconResponse.arrayBuffer())).toEqual(PNG_96)

  const manifest = await (await fetch(`${url}/manifest.webmanifest`)).json()
  expect(manifest).toMatchObject({
    name: 'Orca',
    start_url: 'web-index.html',
    display: 'standalone',
    icons: [{ src: 'orca-web-icon', sizes: '96x96', type: 'image/png' }]
  })
})

it('serves the manifest start_url under a proxy prefix', async () => {
  writeFileSync(join(root, 'assets', 'icon-bundled.png'), PNG_96)
  const url = await startServer()

  const manifestUrl = `${url}/orca/manifest.webmanifest`
  const manifest = await (await fetch(manifestUrl)).json()
  const startUrl = new URL(manifest.start_url, manifestUrl)

  const indexResponse = await fetch(startUrl)
  expect(indexResponse.status).toBe(200)
  expect(await indexResponse.text()).toContain('Orca Web')
})

it('accepts an ORCA_WEB_ICON file with an uppercase extension', async () => {
  const iconPath = join(root, 'custom.PNG')
  writeFileSync(iconPath, PNG_96)
  process.env.ORCA_WEB_ICON = iconPath
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const url = await startServer()

  const iconResponse = await fetch(`${url}/orca-web-icon`)
  expect(iconResponse.status).toBe(200)
  expect(Buffer.from(await iconResponse.arrayBuffer())).toEqual(PNG_96)
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('ORCA_WEB_ICON'))
})

it('falls back to the bundled assets/icon-*.png when ORCA_WEB_ICON is unset', async () => {
  writeFileSync(join(root, 'assets', 'icon-BuNdLe.png'), PNG_96)
  writeFileSync(
    join(root, '.orca-web-client-files.json'),
    JSON.stringify(['web-index.html', 'assets/icon-BuNdLe.png'])
  )
  const url = await startServer()

  expect(await (await fetch(`${url}/`)).text()).toContain('href="./orca-web-icon"')
  const iconResponse = await fetch(`${url}/orca-web-icon`)
  expect(iconResponse.status).toBe(200)
  expect(Buffer.from(await iconResponse.arrayBuffer())).toEqual(PNG_96)
})

it('serves no icon or manifest when no icon source exists', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const url = await startServer()

  expect(await (await fetch(`${url}/`)).text()).not.toContain('rel="icon"')
  expect((await fetch(`${url}/orca-web-icon`)).status).toBe(404)
  expect((await fetch(`${url}/manifest.webmanifest`)).status).toBe(404)
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('ORCA_WEB_ICON'))
})

it('ignores an unreadable ORCA_WEB_ICON and uses the bundled icon', async () => {
  writeFileSync(join(root, 'assets', 'icon-BuNdLe.png'), PNG_96)
  process.env.ORCA_WEB_ICON = join(root, 'missing.png')
  const url = await startServer()

  const iconResponse = await fetch(`${url}/orca-web-icon`)
  expect(iconResponse.status).toBe(200)
  expect(Buffer.from(await iconResponse.arrayBuffer())).toEqual(PNG_96)
})
