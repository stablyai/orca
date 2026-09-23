/**
 * Where the browser's defaults paint something the native app does not, measured in the engine the
 * Android shell runs, at a phone's density, with the plugins and document styles the page ships.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

// The emulator the audit measured on is 480 dpi, which a WebView reports as 3. A launch flag, not
// Playwright's emulated scale: under emulation Chromium floors borders to CSS px, which no phone does.
const DEVICE_SCALE_FLAG = '--force-device-scale-factor=3'

const PAGE_ENTRY = `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { StyleSheet, TextInput, View } from 'react-native'
const styles = StyleSheet.create({
  hairline: { height: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#222222' },
  input: { height: 40 }
})
createRoot(document.getElementById('root')).render(
  h(View, null, h(View, { testID: 'hairline', style: styles.hairline }), h(TextInput, { testID: 'input', style: styles.input }))
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeParity = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null
let browser = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'native-parity-render-'))
  const outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  // The page's own options minus its entry and chunking, so a shim the builder drops fails here.
  const shipped = mobileWebAppBuildOptions([])
  await esbuild.build({
    ...shipped,
    entryPoints: undefined,
    stdin: { contents: PAGE_ENTRY, resolveDir: mobileDir, loader: 'js', sourcefile: 'parity.js' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'parity',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}` +
      `${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head><body><div id="root"></div>` +
      '<script type="module" src="/parity.js"></script></body></html>'
  )
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({
    headless: true,
    args: [DEVICE_SCALE_FLAG],
    ...(executablePath ? { executablePath } : {})
  })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openPage() {
  const page = await browser.newPage({ viewport: null })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="input"]')
  return page
}

describeParity('the page against native, at a phone density', () => {
  it('draws StyleSheet.hairlineWidth one device pixel thick, as native does', async () => {
    const page = await openPage()
    try {
      const measured = await page.evaluate(() => {
        const line = document.querySelector('[data-testid="hairline"]')
        const ratio = window.devicePixelRatio
        return { ratio, devicePixels: Math.round(line.getBoundingClientRect().height * ratio) }
      })
      expect(measured).toEqual({ ratio: 3, devicePixels: 1 })
    } finally {
      await page.close()
    }
  })

  it('paints no focus ring on a focused text input, as no native TextInput does', async () => {
    const page = await openPage()
    try {
      await page.focus('[data-testid="input"]')
      const outline = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="input"]')
        const style = getComputedStyle(input)
        return { focused: document.activeElement === input, style: style.outlineStyle }
      })
      expect(outline).toEqual({ focused: true, style: 'none' })
    } finally {
      await page.close()
    }
  })
})
