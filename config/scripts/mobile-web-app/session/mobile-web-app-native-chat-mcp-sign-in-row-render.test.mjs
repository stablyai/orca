// The MCP sign-in row at the narrowest phone width, in real engines: a long Done label must not squeeze out the status.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import {
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebRenderCheckPlugins
} from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer } from '../preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))
const mcpDir = join(mobileDir, 'src/session/native-chat/mcp')
const PHONE_WIDTH = 320

const PAGE_ENTRY = `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MobileNativeChatMcpPanel } from './MobileNativeChatMcpPanel'
import { activateMobileUiLocale, translate } from '../../../i18n/mobile-i18n'

const server = {
  name: 'Linear',
  status: 'needs-auth',
  source: null,
  toolCount: null,
  error: null,
  canSignIn: true,
  canReconnect: true,
  canToggle: false
}
const noop = () => {}

await activateMobileUiLocale(new URLSearchParams(location.search).get('lang'))
globalThis.__statusText = translate('chat.mcp.status.finishOnPage', 'Finish on the page that opened')
// The root is a flex row; the composer gives the tray the screen's width.
createRoot(document.getElementById('root')).render(
  createElement('div', { style: { width: '100%' } }, createElement(MobileNativeChatMcpPanel, {
    result: { status: 'ok' },
    servers: [server],
    pending: null,
    signIn: { server: server.name, url: 'https://example.com/sign-in', finish: 'external' },
    failure: null,
    run: noop,
    retry: noop,
    dismissSignIn: noop,
    openUrl: noop,
    onClose: noop,
    listMaxHeight: 400
  }))
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeEngines = bundles ? describe : describe.skip

const browsers = {}
let scratch = null
let server = null
let origin = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  // Keep entry under mobile/ so upward bare-import resolution finds component dependencies.
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'mcp-sign-in-row-render-'))
  const outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: { contents: PAGE_ENTRY, resolveDir: mcpDir, loader: 'ts', sourcefile: 'mcp-row.ts' },
    bundle: true,
    format: 'esm',
    outdir: outDir,
    entryNames: 'mcp-row',
    target: ['es2022'],
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    plugins: mobileWebRenderCheckPlugins,
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js'],
    loader: { '.js': 'jsx' },
    banner: {
      js: "globalThis.process ??= { env: { NODE_ENV: 'production', EXPO_OS: 'web' }, platform: 'web', version: '', nextTick: (fn) => setTimeout(fn, 0) };"
    },
    define: {
      global: 'globalThis',
      __DEV__: 'false',
      'process.env.NODE_ENV': '"production"',
      'process.env.EXPO_OS': '"web"'
    }
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}</head>` +
      '<body><div id="root"></div><script type="module" src="/mcp-row.js"></script></body></html>'
  )
  const served = await createBundleServer({ outDir })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browsers.chromium = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  browsers.webkit = await webkit.launch({ headless: true }).catch(() => null)
}, 600_000)

afterAll(async () => {
  await browsers.chromium?.close()
  await browsers.webkit?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function measureRow(browser, lang) {
  const page = await browser.newPage({ viewport: { width: PHONE_WIDTH, height: 640 } })
  await page.goto(`${origin}/?lang=${lang}`)
  await page.waitForFunction(() => typeof globalThis.__statusText === 'string')
  const status = page.getByText(await page.evaluate(() => globalThis.__statusText), {
    exact: true
  })
  const cancel = page.getByRole('button').last()
  const widths = {
    status: (await status.boundingBox())?.width ?? 0,
    cancelRight: await cancel.evaluate((node) => node.getBoundingClientRect().right)
  }
  await page.close()
  return widths
}

for (const engine of ['chromium', 'webkit']) {
  describeEngines(
    `the MCP external sign-in row at ${PHONE_WIDTH}px on ${engine}`,
    () => {
      const browser = () => {
        const one = browsers[engine]
        if (!one) {
          throw new Error(`${engine} is not installed for playwright-core`)
        }
        return one
      }

      for (const lang of ['de', 'en']) {
        it(`keeps the status visible and the actions on screen in ${lang}`, async () => {
          const { status, cancelRight } = await measureRow(browser(), lang)
          expect(status).toBeGreaterThanOrEqual(40)
          expect(cancelRight).toBeLessThanOrEqual(PHONE_WIDTH)
        })
      }
    },
    120_000
  )
}
