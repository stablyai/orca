// Measure real canvas/PNG downscaling under shipped CSP; fake encoders cannot prove output byte size.
// PNG noise resists compression, exercising worst-case screenshots against upload path’s own chunk cap.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import { mobileWebAppBuildOptions } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  readClipboardImageUploadChunkBase64Chars,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))

// Read upload chunk’s base64 cap from production or a duplicated budget could drift.
let uploadChunkBase64Chars = null

/** Noise at this size encodes to more base64 than the chunk above, so the loop has work to do. */
const FIXTURE = { width: 1400, height: 1000 }

const ENTRY_SOURCE = `
import { prepareMobileClipboardImageBase64 } from './mobile-clipboard-image'
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

globalThis.__orcaResizeCheck = async ({ width, height, maxBase64Length }) => {
  const source = noisePng(width, height)
  const resizes = []
  const data = await prepareMobileClipboardImageBase64(
    { data: source, size: { width, height } },
    async (data, target) => {
      const resized = await resizeMobileClipboardImage(data, target)
      resizes.push({ asked: target, answered: { width: resized.width, height: resized.height } })
      return resized
    },
    maxBase64Length
  )
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
  // Keep entry under mobile/ so esbuild’s upward bare-import resolution finds session dependencies.
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
    banner: mobileWebAppBuildOptions([]).banner,
    outfile: join(outDir, 'resize-check.js'),
    target: ['es2022'],
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    // Resolve web sibling; native file requires a picker the browser lacks.
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
    // Remove this run’s scratch only; other suites share mobile/.tmp.
    await rm(scratch, { recursive: true, force: true })
  }
})

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
  // Check evaluation flag: empty body is never visible to a selector wait.
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
          maxBase64Length: uploadChunkBase64Chars
        })

        // Require over-cap input or removing resizer could pass vacuously.

        expect(measured.sourceBase64Length).toBeGreaterThan(uploadChunkBase64Chars)
        expect(measured.resultBase64Length).toBeLessThanOrEqual(uploadChunkBase64Chars)
        // Decode PNG and check dimensions against reported final resize; empty/mismatched encoding must fail.
        const last = measured.resizes.at(-1)
        expect(last).toBeDefined()
        expect(measured.decoded).toEqual(last.answered)
        expect(last.answered).toEqual(last.asked)
        expect(measured.decoded.width).toBeLessThan(FIXTURE.width)
        // Assert CSP explicitly: some browsers resolve decode() despite a policy violation; data: admission is required.
        expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
        expect(consoleErrors).toEqual([])
      } finally {
        await context.close()
      }
    })

    it('rejects a source the browser cannot decode rather than waiting on a load', async () => {
      const { page, context } = await openPage()
      try {
        // decode() rejects invalid images for paste’s catch; onload never fires here.
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
