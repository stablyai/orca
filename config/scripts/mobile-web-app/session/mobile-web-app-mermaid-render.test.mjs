import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { lucideBarrelPlugin } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installCspViolationRecorder,
  installListenerRecorder,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))
const diagramDir = join(mobileDir, 'src/components/pr-sidebar')

// Use design fixture so recorded byte counts remain comparable.
const FIXTURE =
  'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Fix it]\n  D --> A'

const BROKEN = 'graph TD\n  A[[[unclosed'

const ENGINES = [
  {
    name: 'chromium',
    // Use runner Chrome override to avoid CI browser downloads.
    launch: () => {
      const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    }
  },
  { name: 'webkit', launch: () => webkit.launch({ headless: true }) }
]

// Mount actual React component: direct mermaid.render calls cannot prove disposal, fallback or remount behavior.
const PAGE_ENTRY = `
import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MermaidDiagram } from './MermaidDiagram'

// The app root provides insets; the expanded viewer reads them.
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 }
}

function Harness() {
  const [state, setState] = useState({ mounted: false, source: '' })
  useEffect(() => {
    globalThis.__orcaMermaidSet = setState
    document.body.setAttribute('data-ready', 'yes')
  }, [])
  return createElement(
    SafeAreaProvider,
    { initialMetrics: METRICS },
    state.mounted ? createElement(MermaidDiagram, { source: state.source, base: 15 }) : null
  )
}

createRoot(document.getElementById('root')).render(createElement(Harness))
`

const bundles = mobileWebAppDependenciesPresent()
const describeMermaid = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  // Keep entry under mobile/ so upward bare-import resolution finds component dependencies.
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'mermaid-render-'))
  const outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: {
      contents: PAGE_ENTRY,
      resolveDir: diagramDir,
      loader: 'ts',
      sourcefile: 'mermaid-check.ts'
    },
    bundle: true,
    // ESM splitting keeps Mermaid lazy; an IIFE would inline engine into entry.
    format: 'esm',
    splitting: true,
    // Minify as shipped so chunk counts and fetched byte measurements are representative.
    minify: true,
    outdir: outDir,
    entryNames: 'mermaid-check',
    chunkNames: 'chunk-[hash]',
    target: ['es2022'],
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    plugins: [lucideBarrelPlugin],
    // Resolve web sibling; native WebView becomes text in a browser.
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>' +
      '<script type="module" src="/mermaid-check.js"></script></body></html>'
  )
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
}, 600_000)

afterAll(async () => {
  server?.close()
  if (scratch) {
    // Remove this run’s scratch only; other suites share mobile/.tmp.
    await rm(scratch, { recursive: true, force: true })
  }
})

// Record eval/Function stacks to attribute JIT attempts: a library may swallow EvalError under CSP.
// Playwright also evaluates harness functions, so only bundle-script callers count as page JIT.
function installJitRecorder() {
  globalThis.__orcaJit = []
  const record = (kind, source) => {
    // Skip error header and recorder frame to identify caller.
    const stack = (new Error('jit').stack ?? '').split('\n').slice(2).join(' | ')
    globalThis.__orcaJit.push({ kind, source: String(source).slice(0, 60), stack })
  }
  // oxlint-disable-next-line eslint/no-eval -- SAFETY: the recorder holds the real eval so it can count and forward calls; naming it is this function's whole purpose.
  const realEval = globalThis.eval
  // oxlint-disable-next-line eslint/no-eval -- SAFETY: replacing eval with a counting wrapper is the measurement, not a call.
  globalThis.eval = function (source) {
    record('eval', source)
    return realEval.call(globalThis, source)
  }
  const RealFunction = globalThis.Function
  function PatchedFunction(...args) {
    record('Function', args.map((one) => String(one).slice(0, 40)).join('|'))
    return RealFunction.apply(this, args)
  }
  PatchedFunction.prototype = RealFunction.prototype
  globalThis.Function = PatchedFunction
}

// Mermaid marks its drawings; the frame's expand icon is an SVG too.
function readDiagram() {
  const DRAWING = 'svg[aria-roledescription]'
  const frame = document.querySelector('[data-testid="mermaid-diagram"]')
  const svg = frame?.querySelector(DRAWING) ?? null
  return {
    framed: frame !== null,
    inFrame: frame ? frame.querySelectorAll(DRAWING).length : -1,
    // Count SVGs across document too: Mermaid’s temporary body element can orphan diagrams outside component host.
    inDocument: document.querySelectorAll(DRAWING).length,
    sourceBox: document.querySelector('[data-testid="mermaid-diagram-source"]') !== null,
    id: svg?.id ?? null,
    html: svg?.outerHTML ?? null,
    text: frame?.textContent ?? null
  }
}

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await page.addInitScript(installJitRecorder)
  await page.addInitScript(installCspViolationRecorder)
  await page.addInitScript(installListenerRecorder)
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.ready === 'yes')
  return { page, consoleErrors }
}

// On source change, wait for a label unique to replacement; existing SVG already satisfies presence.
async function show(page, source, contains = null) {
  await page.evaluate(
    (next) => globalThis.__orcaMermaidSet({ mounted: true, source: next }),
    source
  )
  await page.waitForFunction((needle) => {
    const frame = document.querySelector('[data-testid="mermaid-diagram"]')
    if (frame === null) {
      return false
    }
    const svg = frame.querySelector('svg[aria-roledescription]')
    if (needle !== null) {
      return (svg?.textContent ?? '').includes(needle)
    }
    return svg !== null || document.querySelector('[data-testid="mermaid-diagram-source"]') !== null
  }, contains)
}

describeMermaid(
  'mermaid on the page',
  () => {
    for (const engine of ENGINES) {
      describe(engine.name, () => {
        let browser = null

        beforeAll(async () => {
          browser = await engine.launch()
        }, 180_000)

        afterAll(async () => {
          await browser?.close()
        })

        it('expands the drawn diagram into the pan and zoom viewer as an image', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            // HTML serialization writes a nonbreaking space as &nbsp;, which an XML image document rejects.
            await show(page, 'flowchart LR\n  A["first#nbsp;second"] --> B[done]', 'second')
            await page.getByRole('button', { name: 'Expand diagram' }).click()
            const image = page.getByRole('img', { name: 'Mermaid diagram' })
            await image.waitFor()
            await page.waitForFunction(
              () => document.querySelector('img[alt="Mermaid diagram"]')?.complete === true
            )
            const drawn = await image.evaluate((img) => ({
              src: img.src.slice(0, 'data:image/svg+xml'.length),
              natural: img.naturalWidth,
              shown: img.getBoundingClientRect().width
            }))
            // An <img> never runs the markup; the diagram must still paint at a real size.
            expect(drawn.src).toBe('data:image/svg+xml')
            expect(drawn.natural).toBeGreaterThan(0)
            expect(drawn.shown).toBeGreaterThan(0)
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('falls back to the source when the diagram throws, and recovers from it', async () => {
          const { page } = await openPage(browser)
          try {
            await show(page, BROKEN)
            const failed = await page.evaluate(readDiagram)
            expect(failed.sourceBox).toBe(true)
            expect(failed.inFrame).toBe(0)
            expect(failed.text).toContain('unclosed')
            // Require component fallback with no leftover Mermaid error diagram.
            expect(failed.inDocument).toBe(0)

            // Valid-diagram control must name new content; existing fallback already satisfies generic settle.
            await show(page, FIXTURE, 'Ship it')
            const recovered = await page.evaluate(readDiagram)
            expect(recovered.sourceBox).toBe(false)
            expect(recovered.inFrame).toBe(1)
          } finally {
            await page.close()
          }
        }, 600_000)
      })
    }
  },
  3_600_000
)
