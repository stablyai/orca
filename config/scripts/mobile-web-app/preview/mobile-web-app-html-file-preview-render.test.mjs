// An HTML file opened on the file-preview route must paint as a page, not as its source text (iOS P0).
// Full bundle, real route, shipped CSP and document headers; WebKit stands in for WKWebView.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp,
  readShellDocumentHeaders
} from './mobile-web-app-render-harness.mjs'
import { probePreviewPixel } from './mobile-web-app-preview-frame-readings.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../../build/mobile-web-app/mobile-web-page-routes.mjs'

const MARKER = 'ORCA_HTML_FILE_RENDERED'
const PAINT_RGB = '0,128,255'
const HTML = `<!doctype html>
<html>
<body style="margin:0;min-height:100vh;background:rgb(${PAINT_RGB})">
<h1>${MARKER}</h1>
</body>
</html>`
const host = { id: 'html-host', name: 'HTML Host', endpoint: 'ws://html-test', lastConnected: 1 }
const pattern = '/h/[hostId]/files/preview/[worktreeId]'
const pathname = '/h/html-host/files/preview/folder-project'
const bundles = mobileWebAppDependenciesPresent()
const shots = process.env.ORCA_MOBILE_HTML_FILE_SHOTS_DIR
const browsers = {}
let scratch, server, origin, version, faultGrant

beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-html-file-render-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const policy = await readShellCsp()
  const documentHeaders = await readShellDocumentHeaders()
  version = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  const served = await createBundleServer({
    outDir: built.outDir,
    cspHeader: policy,
    documentHeaders
  })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browsers.chromium = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  browsers.webkit = await webkit.launch({ headless: true })
  if (shots) {
    await mkdir(shots, { recursive: true })
  }
}, 240_000)

afterAll(async () => {
  await browsers.chromium?.close()
  await browsers.webkit?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openHtmlFile(browser, { line, truncated = false, editable = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const route = MOBILE_WEB_PAGE_ROUTES.find((entry) => entry.pathname === pattern)
  await page.addInitScript(installShellDouble, {
    version,
    sessionId: 'html-session',
    buildId: 'html-build',
    route: {
      pathname,
      params: {
        relativePath: 'index.html',
        name: 'index.html',
        worktreeName: 'Folder project',
        ...(line ? { line } : {}),
        ...(editable
          ? { source: 'terminalArtifact', absolutePath: '/tmp/index.html', grantId: 'html-grant' }
          : {})
      }
    },
    host,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...route.grants, ...(route.optionalGrants ?? [])],
    pageRoutes: [pattern],
    replies: {
      [editable ? 'files.readTerminalArtifact' : 'files.read']: {
        content: HTML,
        byteLength: HTML.length,
        truncated
      }
    }
  })
  await page.goto(`${origin}/`)
  return { context, page, errors }
}

/** Pixel near the frame's bottom: engines refuse DOM reads inside the opaque frame, but not screenshots. */
async function framePixel(page) {
  const box = await page.locator('iframe').boundingBox()
  return await probePreviewPixel(page, {
    x: box.x + box.width / 2,
    y: box.y + box.height - 40,
    width: 4,
    height: 4
  })
}

for (const engine of ['chromium', 'webkit']) {
  const describeRender = bundles ? describe : describe.skip
  describeRender(`an HTML file on the file-preview route on ${engine}`, () => {
    it('renders unsaved HTML edits and retains them when returning to Source', async () => {
      const { context, page, errors } = await openHtmlFile(browsers[engine], { editable: true })
      await page.locator('iframe').waitFor({ timeout: 60_000 })
      await page.getByRole('tab', { name: 'View HTML source' }).click()
      const editor = page.getByRole('textbox', { name: 'index.html editor' })
      await editor.fill(
        '<body style="margin:0;min-height:100vh;background:rgb(255,0,128)">Draft</body>'
      )
      await page.getByRole('tab', { name: 'Preview rendered HTML' }).click()
      await expect.poll(() => framePixel(page), { timeout: 10_000 }).toBe('255,0,128')
      await page.getByRole('tab', { name: 'View HTML source' }).click()
      expect(await editor.inputValue()).toBe(
        '<body style="margin:0;min-height:100vh;background:rgb(255,0,128)">Draft</body>'
      )
      expect(errors).toEqual([])
      await context.close()
    }, 90_000)
  })
}
