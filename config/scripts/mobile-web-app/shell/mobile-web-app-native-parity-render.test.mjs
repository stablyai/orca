// Measure browser defaults absent from native UI at phone density, with shipped plugins/document styles.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import pngjs from 'pngjs'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from '../preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

// Android’s measured 480dpi is scale 3: Chromium launch flag preserves subpixel borders, unlike Playwright emulation.
// WebKit uses emulated scale, matching iOS subpixel border paint.
const ENGINES = [
  {
    name: 'chromium',
    launch: () => {
      const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      return chromium.launch({
        headless: true,
        args: ['--force-device-scale-factor=3'],
        ...(executablePath ? { executablePath } : {})
      })
    },
    pageOptions: { viewport: null }
  },
  {
    name: 'webkit',
    launch: () => webkit.launch({ headless: true }),
    pageOptions: { viewport: { width: 427, height: 952 }, deviceScaleFactor: 3 }
  }
]

// Require CommonJS copy like page dependencies; importing would measure a different react-native build.
const PAGE_ENTRY = `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
const { Modal, StyleSheet, Text, TextInput, View } = require('react-native')
const styles = StyleSheet.create({
  separatorBox: { paddingTop: 10.1, width: 12, backgroundColor: '#ffffff' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#000000' },
  hairline: { height: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#222222' },
  input: { height: 40 }
})
createRoot(document.getElementById('root')).render(
  h(View, null, h(View, { testID: 'separator-box', style: styles.separatorBox }, h(View, { style: styles.separator })), h(View, { testID: 'hairline', style: styles.hairline }), h(TextInput, { testID: 'input', style: styles.input }), h(Text, { testID: 'plain-text' }, 'row'), h(Text, { testID: 'selectable-text', selectable: true }, 'message'), location.hash === '#modal' ? h(Modal, { visible: true, transparent: true }, h(View, null, h(Text, { testID: 'modal-text' }, 'sheet row'), h(TextInput, { testID: 'modal-input', style: styles.input }))) : null)
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeParity = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null
const browsers = new Map()

beforeAll(async () => {
  if (!bundles) {
    return
  }
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'native-parity-render-'))
  const outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  // Reuse page options except entry/chunking so dropping a builder shim fails here.
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
  for (const engine of ENGINES) {
    browsers.set(engine.name, await engine.launch())
  }
}, 180_000)

afterAll(async () => {
  for (const browser of browsers.values()) {
    await browser.close()
  }
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openPage(engine, hash = '') {
  const page = await browsers.get(engine.name).newPage(engine.pageOptions)
  await page.goto(`${origin}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="input"]')
  return page
}

describeParity.each(ENGINES)('the page against native, at a phone density, in $name', (engine) => {
  it('paints a StyleSheet.hairlineWidth-tall separator one device pixel tall at a fractional offset', async () => {
    const page = await openPage(engine)
    try {
      // At 10.1 CSS px, 0.5px separator straddles two device rows in both engines.
      const shot = pngjs.PNG.sync.read(
        await page.locator('[data-testid="separator-box"]').screenshot({ scale: 'device' })
      )
      const column = Math.floor(shot.width / 2)
      let darkRows = 0
      for (let y = 0; y < shot.height; y++) {
        // Count pure black only; final clip row may include neighboring #222222 border.
        if (shot.data[(y * shot.width + column) * 4] < 16) {
          darkRows++
        }
      }
      expect(darkRows).toBe(1)
    } finally {
      await page.close()
    }
  })

  it("selects through the browser's own gesture only what native lets the user select", async () => {
    // Double-click tests user selectability; script-created Range can select otherwise unselectable text.
    const page = await openPage(engine)
    try {
      const selectedBy = async (testId) => {
        await page.evaluate(() => window.getSelection()?.removeAllRanges())
        await page.dblclick(`[data-testid="${testId}"]`)
        return page.evaluate(() => window.getSelection()?.toString() ?? '')
      }
      expect(await selectedBy('plain-text')).toBe('')
      // react-native-web's Text/index.js:115 adds `styles.selectable` (`userSelect: 'text'`).
      expect(await selectedBy('selectable-text')).not.toBe('')

      await page.type('[data-testid="input"]', 'hello world')
      await page.dblclick('[data-testid="input"]')
      const selectedInField = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="input"]')
        return input.selectionEnd - input.selectionStart
      })
      expect(selectedInField).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })
})
