// Render real component in Chromium/WebKit under shipped CSP; verify no bundle JIT/policy violations and inert hostile diagrams.
// Lazy prebundled Mermaid costs one ~3.48MB chunk plus ~284KB entry; package splitting emitted 103 assets against shell’s 256-asset limit.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installCspViolationRecorder,
  installListenerRecorder,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))
const diagramDir = join(mobileDir, 'src/components/pr-sidebar')

// Use design fixture so recorded byte counts remain comparable.
const FIXTURE =
  'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Fix it]\n  D --> A'

// Different shape makes stale SVG after source change visible.
const SECOND = 'graph LR\n  One --> Two\n  Two --> Three'

// Hostile labels/clicks reach document as JS-string data; Mermaid strict sanitization is their security boundary.
const HOSTILE =
  'graph TD\n  A["<img src=x onerror=window.__pwned=1><script>window.__pwned=2<\\/script>"] --> B\n' +
  '  B --> C\n  click A "javascript:window.__pwned=3"\n' +
  '  C --> D["</script><script>window.__pwned=4</script>"]'

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
import { MermaidDiagram } from './MermaidDiagram'

function Harness() {
  const [state, setState] = useState({ mounted: false, source: '' })
  useEffect(() => {
    globalThis.__orcaMermaidSet = setState
    document.body.setAttribute('data-ready', 'yes')
  }, [])
  return state.mounted ? createElement(MermaidDiagram, { source: state.source, base: 15 }) : null
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

// Require a nonempty recorder before filtering bundle JIT; an uninstalled recorder must not pass as no page calls.
async function pageJitCalls(page) {
  const all = await page.evaluate(() => globalThis.__orcaJit)
  expect(all.length).toBeGreaterThan(0)
  return all.filter((one) => /mermaid-check\.js|\/chunk-/.test(one.stack))
}

function readDiagram() {
  const frame = document.querySelector('[data-testid="mermaid-diagram"]')
  const svg = frame?.querySelector('svg') ?? null
  return {
    framed: frame !== null,
    inFrame: frame ? frame.querySelectorAll('svg').length : -1,
    // Count SVGs across document too: Mermaid’s temporary body element can orphan diagrams outside component host.
    inDocument: document.querySelectorAll('svg').length,
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
    const svg = frame.querySelector('svg')
    if (needle !== null) {
      return (svg?.textContent ?? '').includes(needle)
    }
    return svg !== null || document.querySelector('[data-testid="mermaid-diagram-source"]') !== null
  }, contains)
}

async function unmount(page) {
  await page.evaluate(() => globalThis.__orcaMermaidSet({ mounted: false, source: '' }))
  await page.waitForFunction(
    () => document.querySelector('[data-testid="mermaid-diagram"]') === null
  )
}

// Normalize host-generated diagram ID for byte-for-byte remount comparison.
function normaliseSvg(html, id) {
  return html
    .split(id)
    .join('ID')
    .replace(/ xmlns:xlink="[^"]*"/g, '')
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

        it('paints the diagram with no violation and no JIT', async () => {
          const { page, consoleErrors } = await openPage(browser)
          const fetched = []
          page.on('response', (response) => fetched.push(response.url()))
          try {
            await show(page, FIXTURE)
            const shown = await page.evaluate(readDiagram)
            expect(shown.inFrame).toBe(1)
            // Require a rendered Mermaid diagram before absence checks.
            expect(shown.html).toContain('aria-roledescription="flowchart-v2"')
            expect(await pageJitCalls(page)).toEqual([])
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
            // Use CSS-valid ID: Mermaid writes #<id> stylesheet selectors, which «r0» would break.
            expect(shown.id).toMatch(/^[A-Za-z_][\w-]*$/)
            // Require one same-origin on-demand engine chunk; package import fetched 27 chunks here and emitted 103 in app bundle, consuming asset budget.
            expect(fetched.filter((url) => url.includes('/chunk-'))).toHaveLength(1)
            expect(fetched.filter((url) => !url.startsWith(origin))).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('leaves one SVG across a source change, an unmount and a remount', async () => {
          const { page, consoleErrors } = await openPage(browser)
          const listeners = () => page.evaluate(() => globalThis.__orcaListeners.snapshot())
          try {
            const beforeAnyMount = await listeners()
            await show(page, FIXTURE)
            const first = await page.evaluate(readDiagram)
            await unmount(page)
            // Baseline after first full mount cycle: Mermaid’s module-level load listener and RN-Web responder are permanent, not per-mount leaks.
            // Require named Mermaid listener so an empty/uninstalled baseline cannot pass.
            const afterEngineLoaded = await listeners()
            expect(
              Object.keys(afterEngineLoaded).filter((key) => !(key in beforeAnyMount))
            ).toContain('window load')

            await show(page, FIXTURE)
            await show(page, SECOND, 'Three')
            const changed = await page.evaluate(readDiagram)
            // Require one SVG in host and whole document to catch an orphan from first source.
            expect(changed.inFrame).toBe(1)
            expect(changed.inDocument).toBe(1)
            expect(changed.html).not.toBe(first.html)

            await unmount(page)
            const gone = await page.evaluate(readDiagram)
            expect(gone.framed).toBe(false)
            expect(gone.inDocument).toBe(0)
            // Further mounts/source changes must preserve first-cycle listener baseline.
            expect(await listeners()).toEqual(afterEngineLoaded)

            await show(page, FIXTURE)
            const again = await page.evaluate(readDiagram)
            expect(again.inFrame).toBe(1)
            expect(again.inDocument).toBe(1)
            expect(normaliseSvg(again.html, again.id)).toBe(normaliseSvg(first.html, first.id))
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('renders a hostile diagram inert', async () => {
          const { page } = await openPage(browser)
          try {
            await show(page, HOSTILE)
            const inert = await page.evaluate(() => {
              const frame = document.querySelector('[data-testid="mermaid-diagram"]')
              return {
                rendered: frame?.querySelector('svg') !== null,
                scripts: frame.querySelectorAll('script').length,
                inlineHandlers: [...frame.querySelectorAll('*')].filter((element) =>
                  [...element.attributes].some((attribute) => attribute.name.startsWith('on'))
                ).length,
                javascriptHrefs: [...frame.querySelectorAll('[*|href]')]
                  .map(
                    (element) =>
                      element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? ''
                  )
                  .filter((href) => href.toLowerCase().startsWith('javascript:')).length,
                pwned: globalThis.__pwned ?? null
              }
            })
            // Require payload rendered inert, rather than refused before reaching document.
            expect(inert.rendered).toBe(true)
            expect(inert.scripts).toBe(0)
            expect(inert.inlineHandlers).toBe(0)
            expect(inert.javascriptHrefs).toBe(0)
            expect(inert.pwned).toBeNull()
            expect(await pageJitCalls(page)).toEqual([])
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
