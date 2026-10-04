/**
 * Where the browser's defaults paint something the native app does not, measured in the engine the
 * Android shell runs, at a phone's density, with the plugins and document styles the page ships.
 */
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
} from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

// The emulator the audit measured on is 480 dpi, which a WebView reports as 3. Chromium by launch
// flag, not Playwright's emulated scale, under which it floors borders to CSS px as no phone does.
// WebKit (the iOS shell) takes the emulated scale, which is how it paints a sub-pixel border.
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

// Required, not imported: the page's own dependencies require react-native, and esbuild then
// resolves every importer to the package's CommonJS build, so that is the copy the page ships.
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
  it('draws StyleSheet.hairlineWidth one device pixel thick, as native does', async () => {
    const page = await openPage(engine)
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

  it('paints a StyleSheet.hairlineWidth-tall separator one device pixel tall at a fractional offset', async () => {
    const page = await openPage(engine)
    try {
      // 10.1 CSS px down: a 0.5 px separator straddles two device rows there in both engines.
      const shot = pngjs.PNG.sync.read(
        await page.locator('[data-testid="separator-box"]').screenshot({ scale: 'device' })
      )
      const column = Math.floor(shot.width / 2)
      let darkRows = 0
      for (let y = 0; y < shot.height; y++) {
        // Pure black only: the clip's last row can catch the #222222 border drawn below it.
        if (shot.data[(y * shot.width + column) * 4] < 16) {
          darkRows++
        }
      }
      expect(darkRows).toBe(1)
    } finally {
      await page.close()
    }
  })

  it('paints no focus ring on a focused text input, as no native TextInput does', async () => {
    const page = await openPage(engine)
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

  it('leaves only selectable text and editable fields selectable, as native does', async () => {
    // The iOS shell keeps WebKit text interaction on so fields take text, and a hold on plain text
    // would otherwise raise WebKit's selection over the page's own long press.
    const page = await openPage(engine)
    try {
      await page.type('[data-testid="input"]', 'typed')
      const measured = await page.evaluate(() => {
        const select = (id) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`))
        const read = (id) => select(id).webkitUserSelect || select(id).userSelect
        return {
          plain: read('plain-text'),
          selectable: read('selectable-text'),
          input: read('input'),
          value: document.querySelector('[data-testid="input"]').value
        }
      })
      expect(measured).toEqual({ plain: 'none', selectable: 'text', input: 'text', value: 'typed' })
    } finally {
      await page.close()
    }
  })

  it("selects through the browser's own gesture only what native lets the user select", async () => {
    // A double-click, not a Range: a script can select text a user cannot.
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

  it('applies the same to text a modal portals outside #root, and keeps its fields selectable', async () => {
    // react-native-web's Modal appends to document.body, so a rule on #root would miss sheets.
    // The fields' callout exemption goes unmeasured: desktop WebKit lacks the property.
    const page = await openPage(engine, '#modal')
    try {
      await page.waitForSelector('[data-testid="modal-text"]')
      const measured = await page.evaluate(() => {
        const text = document.querySelector('[data-testid="modal-text"]')
        const input = document.querySelector('[data-testid="modal-input"]')
        const read = (node) =>
          getComputedStyle(node).webkitUserSelect || getComputedStyle(node).userSelect
        return {
          outsideRoot: !document.getElementById('root').contains(text),
          text: read(text),
          input: read(input)
        }
      })
      expect(measured).toEqual({
        outsideRoot: true,
        text: 'none',
        input: 'text'
      })
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await page.dblclick('[data-testid="modal-text"]')
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    } finally {
      await page.close()
    }
  })
})
