import type { PopupCompatibilityStatus } from './browser-popup-compatibility-status'
import { spawnProcess } from '@orca/process-host'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import { build as buildVite } from 'vite'
import { waitForBrowserCdpEndpoint } from './browser-session-ua-cdp-collector'
import { popupFixtureHtml } from './browser-popup-compatibility-page-fixture'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'
import {
  HIDDEN_RENDERER_FIRST_FRAME_TIMEOUT_MS,
  startHiddenRendererFrameCapture
} from './hidden-renderer-frame-capture-fixture'

// Hidden renderer startup and CDP events can exceed the default one-second poll on CI.
vi.setConfig({ expect: { poll: { timeout: 10_000 } } })

export type PopupFixtureReceipt = {
  path: string
  method: string
  body: string
  cookie: string
  referrer: string
  contentType: string
  proxied: boolean
  origin: string
  fetchSite: string
  fetchMode: string
  fetchDest: string
  fetchUser: string
}
export const receipts: PopupFixtureReceipt[] = []
const root = mkdtempSync(join(tmpdir(), 'orca-popup-compatibility-'))
let fixture: ReturnType<typeof spawnProcess> | null = null
export let browser: Browser | null = null
export let origin = ''
let stderr = ''
const pages = new Map<string, Page>()
const stopFrameCaptures = new Map<Page, () => Promise<void>>()
const statusPath = join(root, 'status.json')
export const artifactDir = process.env.ORCA_POPUP_FIXTURE_ARTIFACT_DIR
export const snapshots: ReturnType<typeof status>[] = []
export const expectedSecurity = { sandbox: true, contextIsolation: true, nodeIntegration: false }

export function status(): PopupCompatibilityStatus {
  return JSON.parse(readFileSync(statusPath, 'utf8'))
}

const cdpConnected = Promise.withResolvers<void>()
const server = createServer((request, response) => {
  if (request.url === '/fixture-cdp-connected') {
    void cdpConnected.promise.then(() => response.writeHead(204).end())
    return
  }
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const path = new URL(request.url ?? '/', origin).pathname
    receipts.push({
      path,
      method: request.method ?? '',
      body: Buffer.concat(chunks).toString(),
      cookie: request.headers.cookie ?? '',
      referrer: request.headers.referer ?? '',
      contentType: request.headers['content-type'] ?? '',
      proxied: request.url?.startsWith('http:') ?? false,
      origin: String(request.headers.origin ?? ''),
      fetchSite: String(request.headers['sec-fetch-site'] ?? ''),
      fetchMode: String(request.headers['sec-fetch-mode'] ?? ''),
      fetchDest: String(request.headers['sec-fetch-dest'] ?? ''),
      fetchUser: String(request.headers['sec-fetch-user'] ?? '')
    })
    if (path === '/native-redirect') {
      response.writeHead(307, {
        Location: `${origin.replace('127.0.0.1', 'localhost')}/native-final`
      })
      response.end()
      return
    }
    if (path === '/seed') {
      response.setHeader('Set-Cookie', 'strict_cookie=synthetic; SameSite=Strict; Path=/')
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(
      ['/local', '/route', '/local-control', '/route-control', '/probe-one', '/probe-two'].includes(
        path
      )
        ? popupFixtureHtml(origin)
        : `<title>Hostile synthetic title</title><body>${path}<script>if(window.opener)window.opener.postMessage('callback:'+document.cookie,'*')</script></body>`
    )
  })
})

async function reservePort(): Promise<number> {
  const portServer = createPortServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing CDP port')
  }
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  return address.port
}

async function waitForFixture(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Popup fixture did not become ready: ${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing mock origin')
  }
  origin = `http://127.0.0.1:${address.port}`
  // Rebuild the hidden-window launch policy before launching Electron.
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: {
        entry: join(
          process.cwd(),
          'src/main/browser/browser-popup-compatibility-electron-fixture.ts'
        ),
        formats: ['cjs'],
        fileName: () => 'main.cjs'
      },
      outDir: root,
      emptyOutDir: false,
      target: 'node22',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  const electronBinary: unknown = createRequire(import.meta.url)('electron')
  if (typeof electronBinary !== 'string') {
    throw new Error('Missing Electron executable')
  }
  const cdpPort = await reservePort()
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs: [
      join(root, 'main.cjs'),
      `--user-data-dir=${join(root, 'profile')}`,
      `--remote-debugging-port=${cdpPort}`
    ],
    platform: process.platform,
    display: env.DISPLAY
  })
  fixture = spawnProcess({
    program: executable,
    args,
    env: {
      ...env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_POPUP_FIXTURE_ORIGIN: origin,
      ORCA_POPUP_FIXTURE_STATUS: statusPath,
      ORCA_POPUP_FIXTURE_NATIVE_CONTROLS: nativeControls ? '1' : '0',
      ORCA_POPUP_FIXTURE_ADAPTER_PROBE: adapterProbe ? '1' : '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  fixture.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  await waitForBrowserCdpEndpoint(cdpPort)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  cdpConnected.resolve()
  await waitForFixture(() => {
    if (!existsSync(statusPath)) {
      return false
    }
    const current = status()
    if (current.error) {
      throw new Error(current.error)
    }
    return current.ready === true
  })
  expect(status()).toMatchObject({ ready: true, windowsHidden: true })
  const names = [
    'local',
    'route',
    ...(nativeControls ? ['local-control', 'route-control'] : []),
    ...(adapterProbe ? ['probe-one', 'probe-two'] : [])
  ]
  for (const name of names) {
    await waitForFixture(() =>
      Boolean(
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .some((page) => page.url() === `${origin}/${name}`)
      )
    )
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === `${origin}/${name}`)
    if (!page) {
      throw new Error('Missing guest page')
    }
    pages.set(name, page)
    // Wait for the first compositor frame during startup; fresh CI GPU initialization can be slow.
    stopFrameCaptures.set(
      page,
      await startHiddenRendererFrameCapture(page, (hasFrame) =>
        waitForFixture(hasFrame, HIDDEN_RENDERER_FIRST_FRAME_TIMEOUT_MS).catch((error: unknown) => {
          throw new Error(`No first frame for ${name}`, { cause: error })
        })
      )
    )
  }
}, 90_000)

afterEach(async () => {
  const route = pages.get('route')
  if (route && !route.isClosed()) {
    await route.evaluate('console.log("orca-popup-fixture:restore-authority")')
  }
  const local = pages.get('local')
  if (local && !local.isClosed()) {
    await closeChildren(local)
  }
})

afterAll(async () => {
  cdpConnected.resolve()
  await Promise.allSettled([...stopFrameCaptures.values()].map((stop) => stop()))
  if (artifactDir && existsSync(statusPath)) {
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(
      join(artifactDir, evidenceName),
      JSON.stringify({ status: status(), receipts, snapshots }, null, 2)
    )
  }
  if (fixture?.exitCode === null) {
    const exited = new Promise<void>((resolve) => fixture?.once('exit', () => resolve()))
    fixture.kill('SIGTERM')
    await exited
  }
  await browser?.close().catch(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

export function guest(name: string): Page {
  const page = pages.get(name)
  if (!page) {
    throw new Error('Missing fixture guest')
  }
  return page
}

export async function closeChildren(page: Page): Promise<void> {
  await page.evaluate('window.popup?.close();window.handles?.forEach(handle=>handle?.close())')
  if (!browser) {
    throw new Error('Missing fixture browser')
  }
  for (const child of browser.contexts().flatMap((context) => context.pages())) {
    if (
      ![...pages.values()].includes(child) &&
      (child.url().startsWith(origin) ||
        child.url().startsWith(origin.replace('127.0.0.1', 'localhost')))
    ) {
      await child.evaluate('window.close()').catch(() => {})
      await expect.poll(() => child.isClosed()).toBe(true)
    }
  }
}

let evidenceName = 'electron-evidence.json'
let nativeControls = false
let adapterProbe = false
export function enablePopupAdapterProbe(): void {
  adapterProbe = true
}
export function enablePopupFixtureNativeControls(): void {
  nativeControls = true
}
export function setPopupFixtureEvidenceName(name: string): void {
  evidenceName = name
}
