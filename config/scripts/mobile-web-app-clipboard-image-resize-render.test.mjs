/**
 * The clipboard image's downscale, run in a real browser under the shipped policy against a real
 * raster.
 *
 * The native path shrinks with `expo-image-manipulator` through two `expo-file-system` writes, and
 * the page has neither: its sibling draws into a `<canvas>` and reads the PNG back out. A fake
 * canvas cannot answer the question the loop above it asks — how many bytes a raster weighs once
 * re-encoded — so this measures it rather than asserting about it.
 *
 * The fixture is noise, for the reason the browser pane's budget uses noise: it is the image PNG
 * compresses least, so a run that converges here converges on the picture a screenshot is at worst.
 * The budget the run is held to is the upload path's own chunk, passed to the real downscale loop.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  readClipboardImageUploadChunkBase64Chars,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

/**
 * The budget the run is held to: the chunk the upload path already sends, in base64 characters,
 * read from the module that defines it rather than written down a second time.
 */
let uploadChunkBase64Chars = null

/** Noise at this size encodes to more base64 than the chunk above, so the loop has work to do. */
const FIXTURE = { width: 1400, height: 1000 }

/**
 * The page under test: the real resizer and the real downscale loop, with nothing else in it.
 *
 * `prepare` is inlined from `mobile-clipboard-image.ts` rather than imported, because that module
 * pulls the upload path's RPC operations and its logical client with it; the two functions it
 * needs are imported from the leaf that holds them, so the arithmetic here is the product's.
 */
const ENTRY_SOURCE = `
import { computeMobileClipboardImageDownscale } from './mobile-clipboard-image-downscale'
import { resizeMobileClipboardImage } from './mobile-clipboard-image-resize'

function noisePng(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  const pixels = context.createImageData(width, height)
  // A linear congruential generator, so the fixture is the same raster on every run.
  let seed = 20260920
  for (let index = 0; index < pixels.data.length; index += 4) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    pixels.data[index] = seed % 256
    pixels.data[index + 1] = (seed >> 8) % 256
    pixels.data[index + 2] = (seed >> 16) % 256
    pixels.data[index + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png').replace(/^data:image\\/png;base64,/, '')
}

async function measuredDimensions(base64) {
  const image = new Image()
  image.src = 'data:image/png;base64,' + base64
  await image.decode()
  return { width: image.naturalWidth, height: image.naturalHeight }
}

globalThis.__orcaResizeCheck = async ({ width, height, maxBase64Length, attempts }) => {
  const source = noisePng(width, height)
  const resizes = []
  let data = source
  let size = { width, height }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const target = computeMobileClipboardImageDownscale(
      data.length,
      size.width,
      size.height,
      maxBase64Length
    )
    if (!target) {
      break
    }
    const resized = await resizeMobileClipboardImage(data, target)
    resizes.push({ asked: target, answered: { width: resized.width, height: resized.height } })
    data = resized.data
    size = { width: resized.width, height: resized.height }
  }
  return {
    sourceBase64Length: source.length,
    resultBase64Length: data.length,
    resizes,
    decoded: await measuredDimensions(data)
  }
}

globalThis.__orcaResizeRefusal = async (source) => {
  try {
    await resizeMobileClipboardImage(source, { width: 8, height: 8 })
    return null
  } catch (error) {
    return String(error && error.message)
  }
}
document.body.setAttribute('data-ready', 'yes')
`

const bundles = mobileWebAppDependenciesPresent()
const describeResize = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null
let browser = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  const cspHeader = await readShellCsp()
  uploadChunkBase64Chars = await readClipboardImageUploadChunkBase64Chars()
  // Inside mobile/ rather than the system temp dir: the entry resolves the session modules beside
  // it, and esbuild resolves a bare specifier from the importer upward.
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'clipboard-resize-render-'))
  const outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: {
      contents: ENTRY_SOURCE,
      resolveDir: join(mobileDir, 'src/session'),
      loader: 'ts',
      sourcefile: 'resize-check.ts'
    },
    bundle: true,
    format: 'iife',
    outfile: join(outDir, 'resize-check.js'),
    target: ['es2022'],
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    // The web sibling is what the page runs; naming the native file would measure the module that
    // needs a native picker to exist.
    resolveExtensions: ['.web.ts', '.web.js', '.ts', '.js'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
      '<body><script src="/resize-check.js"></script></body></html>'
  )
  const served = await createBundleServer({ outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    // This run's directory only: `mobile/.tmp` is a shared ignored root and another suite may hold
    // one of its own.
    await rm(scratch, { recursive: true, force: true })
  }
})

/** One page, with its console, its page errors and its policy violations watched. */
async function openPage() {
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.addInitScript(() => {
    globalThis.__orcaCspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__orcaCspViolations.push(event.violatedDirective)
    })
  })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  // A function rather than a selector: an empty body is never "visible", and the flag is what
  // says the bundle evaluated.
  await page.waitForFunction(() => document.body.dataset.ready === 'yes')
  return { page, context, consoleErrors }
}

describeResize(
  'the clipboard image downscale on the page',
  () => {
    it('brings a noise PNG under the upload chunk, and says what it weighed', async () => {
      const { page, context, consoleErrors } = await openPage()
      try {
        const measured = await page.evaluate((args) => globalThis.__orcaResizeCheck(args), {
          ...FIXTURE,
          maxBase64Length: uploadChunkBase64Chars,
          attempts: 3
        })

        // The fixture is over the budget, so the loop had something to do: a run that started
        // under it would pass this file with the resizer removed.

        expect(measured.sourceBase64Length).toBeGreaterThan(uploadChunkBase64Chars)
        expect(measured.resultBase64Length).toBeLessThanOrEqual(uploadChunkBase64Chars)
        // Still a PNG a browser can read, at the size the last resize reported: a canvas that
        // encoded nothing, or reported a size it had not drawn, would be caught here.
        const last = measured.resizes.at(-1)
        expect(last).toBeDefined()
        expect(measured.decoded).toEqual(last.answered)
        expect(last.answered).toEqual(last.asked)
        expect(measured.decoded.width).toBeLessThan(FIXTURE.width)
        // The policy admits the source: the `data:` of `img-src 'self' data: https:` is what the
        // decode rests on, and a page that violated it would still resolve `decode()` on some
        // browsers.
        expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
        expect(consoleErrors).toEqual([])
      } finally {
        await context.close()
      }
    })

    it('rejects a source the browser cannot decode rather than waiting on a load', async () => {
      const { page, context } = await openPage()
      try {
        // `onload` never fires for this; `decode()` is what makes it a rejection the paste's own
        // catch can put on screen.
        const message = await page.evaluate(
          (source) => globalThis.__orcaResizeRefusal(source),
          'bm90LWFuLWltYWdl'
        )
        expect(message).toMatch(/decode/i)
      } finally {
        await context.close()
      }
    })
  },
  300_000
)
