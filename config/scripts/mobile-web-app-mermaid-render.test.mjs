/**
 * Mermaid rendered in the page, in a real browser, under the policy the shell ships.
 *
 * The native component seals an untrusted diagram inside a `WebView` whose document embeds the
 * whole engine as a string. The page has no second content process, so what replaces it is
 * `import('mermaid')` on demand and mermaid's own `securityLevel: 'strict'` output. That makes
 * three claims this file measures rather than asserts: that rendering violates no directive and
 * asks for no JIT, that what the page paints is the diagram the phone already paints, and that a
 * hostile diagram reaches the document inert.
 *
 * The equality oracle is the native `buildHtml` itself, bundled and served as its own document in
 * the same browser. Two differences survive and are normalised away: the diagram id (mermaid's own
 * `mermaid-<epoch>` on the native path, the component's `useId` on the page) and the `xmlns:xlink`
 * declaration the native document's `innerHTML` serialization adds. Everything else — the viewBox,
 * the `max-width`, the injected `<style>`'s rules — is compared byte for byte.
 *
 * Both engines, because the shell is WKWebView on one platform and a Chromium WebView on the
 * other, and "does mermaid need eval" is answered by the engine rather than by mermaid.
 *
 * Recorded from this file's own run, for whoever needs the trade. Rendering one `graph TD` fetches
 * one chunk of 3,482,965 minified bytes on top of a 283,956-byte entry — the pre-bundled engine,
 * not in the entry, and not fetched at all by a page with no diagram on it (ruling 28's fence,
 * held in `mobile-web-app-session-terminal-closure.test.mjs`). One chunk rather than the 103 that
 * `import('mermaid')` emitted: mermaid splits along its own lazy diagram-type boundaries, all of
 * which sit inside the generation the phone has already downloaded, so that split moved no bytes
 * and spent 103 of the 256 manifest assets the shell will load. The native document pays 3,705,846
 * bytes of engine string instead, in the closure, on every mount.
 *
 * The SVG itself: 17,143 bytes on the page against 17,504 in the native document (chromium; webkit
 * is 8 longer on each side), equal at 15,447 once normalised. The gap is the id string repeated
 * across 57 selectors, and dropping `xmlns:xlink` is load-bearing rather than cosmetic — the
 * comparison fails without it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installCspViolationRecorder,
  installListenerRecorder,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))
const diagramDir = join(mobileDir, 'src/components/pr-sidebar')

/** The design's own fixture, so the byte counts in the docstring above name this diagram. */
const FIXTURE =
  'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Fix it]\n  D --> A'

/** A second valid diagram for the source change: a different shape, so a stale SVG is visible. */
const SECOND = 'graph LR\n  One --> Two\n  Two --> Three'

/**
 * A script in a label, a `</script>` in a label, an `onerror` attribute and a `javascript:` click.
 *
 * The native path escapes `<`, `>` and the line separators because the source is spliced into an
 * inline `<script>`; on the page it is a JS string argument and that escaping has no analogue, so
 * the only fence left is mermaid's own strict-mode sanitiser. This is what measures it.
 */
const HOSTILE =
  'graph TD\n  A["<img src=x onerror=window.__pwned=1><script>window.__pwned=2<\\/script>"] --> B\n' +
  '  B --> C\n  click A "javascript:window.__pwned=3"\n' +
  '  C --> D["</script><script>window.__pwned=4</script>"]'

/** Not a diagram in any grammar mermaid has, so `render` rejects and the component falls back. */
const BROKEN = 'graph TD\n  A[[[unclosed'

const ENGINES = [
  {
    name: 'chromium',
    // CI runs this against the runner's Google Chrome rather than paying for a download, the same
    // override shape as every other render check here.
    launch: () => {
      const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    }
  },
  { name: 'webkit', launch: () => webkit.launch({ headless: true }) }
]

/**
 * The page under test: the real component, mounted by the real React, with a handle on its props.
 *
 * Not a re-implementation of what the component does — the dispose, the fallback and the remount
 * are the behaviour under test, and a probe that called `mermaid.render` itself would prove
 * nothing about any of them.
 */
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

/**
 * A stand-in for React, React Native and `react-native-webview`, so the native module can be
 * bundled for Node to get its HTML.
 *
 * `buildHtml` is a pure function of the source and the theme, but it lives beside a component
 * whose other imports are all native. CommonJS with a Proxy rather than a list of named exports:
 * what that component reaches for is its own business, and none of it is called here.
 */
const IMPORT_STUB = `
const identity = (value) => value
module.exports = new Proxy(
  {
    StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
    memo: identity,
    default: identity
  },
  { get: (target, key) => (key in target ? target[key] : identity) }
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeMermaid = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null

/** The native document's own render of `FIXTURE`, built from `buildHtml` and served as a page. */
async function buildNativeDocument(outDir) {
  const stubPath = join(scratch, 'import-stub.cjs')
  await writeFile(stubPath, IMPORT_STUB, 'utf8')
  const nativeHtmlModule = join(scratch, 'native-html.mjs')
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: {
      contents: "export { buildHtml } from './MermaidDiagram'\n",
      resolveDir: diagramDir,
      loader: 'ts',
      sourcefile: 'native-html-entry.ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: nativeHtmlModule,
    target: ['node20'],
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    // `resolveExtensions` is left at its default here, with no `.web.*`, so `./MermaidDiagram`
    // resolves to the file the phone builds rather than to the sibling under test.
    alias: {
      react: stubPath,
      'react/jsx-runtime': stubPath,
      'react-native': stubPath,
      'react-native-webview': stubPath
    },
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }
  })
  const { buildHtml } = await import(pathToFileURL(nativeHtmlModule).href)
  await writeFile(join(outDir, 'native.html'), buildHtml(FIXTURE), 'utf8')
  // The same document for a diagram that throws, because the shared config the page introduced
  // reaches the phone too and one of its keys changes what mermaid does on that path.
  await writeFile(join(outDir, 'native-broken.html'), buildHtml(BROKEN), 'utf8')
}

beforeAll(async () => {
  if (!bundles) {
    return
  }
  // Inside mobile/ rather than the system temp dir: the entry resolves the component beside it,
  // and esbuild resolves a bare specifier from the importer upward.
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
    // esm with splitting, because `import('mermaid')` has to be a chunk the browser fetches when
    // the diagram renders. An iife would inline the engine into the entry, which is the one shape
    // this item exists to avoid.
    format: 'esm',
    splitting: true,
    // Minified, like the bundle the shell serves: the chunk count and the bytes one render fetches
    // are numbers this file records, and an unminified bundle records neither.
    minify: true,
    outdir: outDir,
    entryNames: 'mermaid-check',
    chunkNames: 'chunk-[hash]',
    target: ['es2022'],
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    // The web sibling is what the page runs; the native file reaches a WebView that a browser
    // renders as a line of text.
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>' +
      '<script type="module" src="/mermaid-check.js"></script></body></html>'
  )
  await buildNativeDocument(outDir)
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
}, 600_000)

afterAll(async () => {
  server?.close()
  if (scratch) {
    // This run's directory only: `mobile/.tmp` is a shared ignored root and another suite may hold
    // one of its own.
    await rm(scratch, { recursive: true, force: true })
  }
})

/**
 * Every `eval` and `new Function` attempted on the page, with the stack that asked for it.
 *
 * `script-src 'self'` carries no `'unsafe-eval'`, so a JIT call raises a violation too — but a
 * library that catches its own `EvalError` and takes a slower path would leave that violation
 * looking like noise from elsewhere. The stack is what names the caller, and it has to, because
 * Playwright evaluates every one of this file's own page functions through `eval`: the calls on
 * this list are mostly the harness's, and only the ones from the bundle's scripts are the page's.
 */
function installJitRecorder() {
  globalThis.__orcaJit = []
  const record = (kind, source) => {
    // Line 0 is the error's own header and line 1 is this recorder; the rest is whoever asked.
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

/**
 * The JIT calls that came from the bundle rather than from the harness driving it.
 *
 * `__orcaJit` being non-empty is the precondition: an attribution filter over a list nothing ever
 * wrote to answers "none from the page" for a recorder that was never installed.
 */
async function pageJitCalls(page) {
  const all = await page.evaluate(() => globalThis.__orcaJit)
  expect(all.length).toBeGreaterThan(0)
  return all.filter((one) => /mermaid-check\.js|\/chunk-/.test(one.stack))
}

/** What the component has on the page: its frame, the SVG under it, and every SVG anywhere. */
function readDiagram() {
  const frame = document.querySelector('[data-testid="mermaid-diagram"]')
  const svg = frame?.querySelector('svg') ?? null
  return {
    framed: frame !== null,
    inFrame: frame ? frame.querySelectorAll('svg').length : -1,
    // Every SVG in the document, not only the framed one: mermaid renders into a temporary
    // element of its own, and an orphan left in the body is invisible to a count under the host.
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

/**
 * Drives the harness and waits for the component to settle into a diagram or a fallback.
 *
 * `contains` is for a source change, where "an SVG is present" is already true of the diagram being
 * replaced: naming a label only the new diagram carries is what makes the wait about the new one.
 */
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

/**
 * The two strings, with the only two differences the design measured taken out: the diagram id,
 * which each host generates its own way, and the `xmlns:xlink` the native serialization adds.
 *
 * The id is read off the element rather than matched by a pattern, so a host that changes its id
 * scheme normalises correctly instead of comparing an unreplaced string.
 */
function normaliseSvg(html, id) {
  return html
    .split(id)
    .join('ID')
    .replace(/ xmlns:xlink="[^"]*"/g, '')
}

/**
 * The native document, loaded in the same browser, with the host it posts to standing in.
 *
 * `window.ReactNativeWebView` is what the WebView injects; the document's `post` is a no-op
 * without it, so the message that drives the component's fallback would be unobservable. Recorded
 * as a list because the two outcomes are told apart by what it posts: a height, or `error`.
 */
async function readNativeDocument(browser, file) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.addInitScript(() => {
      globalThis.__orcaNativePosts = []
      globalThis.ReactNativeWebView = {
        postMessage: (message) => globalThis.__orcaNativePosts.push(String(message))
      }
    })
    await page.goto(`${origin}/${file}`, { waitUntil: 'load' })
    await page.waitForFunction(() => globalThis.__orcaNativePosts.length > 0, null, {
      timeout: 120_000
    })
    return await page.evaluate(() => {
      const svg = document.querySelector('#c svg')
      return {
        posts: globalThis.__orcaNativePosts,
        svgs: document.querySelectorAll('svg').length,
        html: svg?.outerHTML ?? null,
        id: svg?.id ?? null
      }
    })
  } finally {
    await page.close()
  }
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

        it('paints the diagram the native document paints, with no violation and no JIT', async () => {
          const { page, consoleErrors } = await openPage(browser)
          const fetched = []
          page.on('response', (response) => fetched.push(response.url()))
          try {
            await show(page, FIXTURE)
            const shown = await page.evaluate(readDiagram)
            expect(shown.inFrame).toBe(1)
            // The precondition the absences below need: a diagram rendered, and it is mermaid's.
            expect(shown.html).toContain('aria-roledescription="flowchart-v2"')
            expect(await pageJitCalls(page)).toEqual([])
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
            // A CSS identifier, because mermaid writes `#<id>` into the stylesheet it puts inside
            // the SVG; an id spelled `«r0»` would leave every one of those rules inert.
            expect(shown.id).toMatch(/^[A-Za-z_][\w-]*$/)
            // On demand, from here, and in one piece: the engine arrived as exactly one chunk the
            // render asked for, and nothing was fetched off this origin. The count is the claim —
            // importing the package rather than the artifact fetched 27 here and emitted 103 in
            // the app bundle, which is what spends the shell's asset budget.
            expect(fetched.filter((url) => url.includes('/chunk-'))).toHaveLength(1)
            expect(fetched.filter((url) => !url.startsWith(origin))).toEqual([])

            const native = await readNativeDocument(browser, 'native.html')
            expect(normaliseSvg(shown.html, shown.id)).toBe(normaliseSvg(native.html, native.id))
          } finally {
            await page.close()
          }
        }, 600_000)

        it('leaves the native document reporting a diagram that throws, with nothing drawn', async () => {
          // The page's shared config reaches the phone as well, and `suppressErrorRendering` is a
          // key the native path did not have before it. What must not change is that the component
          // above the WebView still hears about a diagram that throws: `run` rethrows, the
          // document's own catch posts `error`, and the component swaps in the source box.
          const broken = await readNativeDocument(browser, 'native-broken.html')
          expect(broken.posts).toEqual(['error'])
          // And what the key does change: mermaid draws no error diagram of its own, so the
          // document is empty behind the fallback rather than showing a diagram for a moment.
          expect(broken.svgs).toBe(0)

          // The control, the same document for a diagram that parses: a height, not `error`.
          const rendered = await readNativeDocument(browser, 'native.html')
          expect(rendered.posts).not.toContain('error')
          expect(Number(rendered.posts[0])).toBeGreaterThan(0)
          expect(rendered.svgs).toBe(1)
        }, 600_000)

        it('leaves one SVG across a source change, an unmount and a remount', async () => {
          const { page, consoleErrors } = await openPage(browser)
          const listeners = () => page.evaluate(() => globalThis.__orcaListeners.snapshot())
          try {
            const beforeAnyMount = await listeners()
            await show(page, FIXTURE)
            const first = await page.evaluate(readDiagram)
            await unmount(page)
            // A first mount installs listeners no dispose can take off, and they are not a leak:
            // mermaid's own `window` `load` (inert under `startOnLoad: false`, and the module's
            // rather than the mount's) and react-native-web's responder system, which arms itself
            // on the first `View` the page renders. So the baseline a per-mount leak would move is
            // the snapshot after one whole cycle, not the one before it — with mermaid's named,
            // because a cycle that installed nothing would make the comparison below vacuous.
            const afterEngineLoaded = await listeners()
            expect(
              Object.keys(afterEngineLoaded).filter((key) => !(key in beforeAnyMount))
            ).toContain('window load')

            await show(page, FIXTURE)
            await show(page, SECOND, 'Three')
            const changed = await page.evaluate(readDiagram)
            // One in the frame and one in the document: a diagram the first source left behind
            // would be the second, wherever it hung.
            expect(changed.inFrame).toBe(1)
            expect(changed.inDocument).toBe(1)
            expect(changed.html).not.toBe(first.html)

            await unmount(page)
            const gone = await page.evaluate(readDiagram)
            expect(gone.framed).toBe(false)
            expect(gone.inDocument).toBe(0)
            // Two mounts and a source change later, the page is listening to exactly what it was
            // after the first of them. A mount that registered anything of its own would show up
            // here as the third.
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
            // Rendered rather than refused, which is the whole point: the payload is carried into
            // the document as data and does nothing there.
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
            // The fallback is a state of this component, not a page with a diagram left on it:
            // mermaid draws its own error diagram unless it is told not to.
            expect(failed.inDocument).toBe(0)

            // The control: the same component, the same mount, a diagram that parses. Named,
            // because the fallback it is replacing already satisfies a bare settle.
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
