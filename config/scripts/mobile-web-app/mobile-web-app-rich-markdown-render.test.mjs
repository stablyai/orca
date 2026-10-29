// Exercise real editor in Chromium/WebKit under shipped CSP: toolbar effects, private ready/change seam, listener/style cleanup, font floor and URL modal.
// Native WebView postMessage/injectJavaScript are replaced by direct module calls; execCommand behavior requires real engines.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  lucideBarrelPlugin
} from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { textInputFontSizeFloor } from './platform-seams/mobile-web-app-text-input-font-size-seam.mjs'
import {
  createBundleServer,
  installCspViolationRecorder,
  installListenerRecorder,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))
const componentDir = join(mobileDir, 'src/components')

// Read font floor from seam module; a copied 16 would silently drift when theme body size rises above it.
const FLOOR = textInputFontSizeFloor(mobileDir)

const COMMANDS = [
  { label: 'H1', command: 'heading1', select: 'all', expect: 'h1' },
  { label: 'H2', command: 'heading2', select: 'all', expect: 'h2' },
  { label: 'H3', command: 'heading3', select: 'all', expect: 'h3' },
  { label: 'Bold', command: 'bold', select: 'word', expect: 'b,strong' },
  { label: 'Italic', command: 'italic', select: 'word', expect: 'i,em' },
  { label: 'Strike', command: 'strike', select: 'word', expect: 'strike,s,del' },
  { label: 'Bullet list', command: 'bulletList', select: 'all', expect: 'ul' },
  { label: 'Numbered list', command: 'orderedList', select: 'all', expect: 'ol' },
  { label: 'Checklist', command: 'taskList', select: 'all', expect: 'ul[data-type="taskList"]' },
  { label: 'Quote', command: 'quote', select: 'all', expect: 'blockquote' },
  { label: 'Inline code', command: 'inlineCode', select: 'word', expect: 'code' },
  { label: 'Code block', command: 'codeBlock', select: 'all', expect: 'pre' }
]

// Paragraph undoes another command; starting from p would prove nothing.
const PARAGRAPH = { label: 'Body', command: 'paragraph' }

// Serve inserted image locally: nonexistent URL logs WebKit load failure; successful paint proves shipped CSP admits it.
const IMAGE_PATH = '/inserted.png'
const URL_COMMANDS = [
  { label: 'Link', title: 'Link URL', path: '/linked', expect: 'a[href]' },
  { label: 'Image', title: 'Image URL', path: IMAGE_PATH, expect: 'img' }
]

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

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

// Mount actual component/controller/modules; direct runCommand bypasses tested toolbar and mount behavior.
// Feed onChange into content like MarkdownReader or controller overwrites every edit from stale prop.
const PAGE_ENTRY = `
import { createElement, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MobileRichMarkdownEditor } from './MobileRichMarkdownEditor'

/**
 * What the route's own navigator supplies and a bare mount does not: react-navigation wraps every
 * screen in a safe-area provider, and the URL modal's drawer reads the insets from it. Without one
 * the modal throws where the page has no problem at all.
 */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 }
}

function Harness() {
  const [state, setState] = useState({
    mounted: true,
    generation: 0,
    content: '',
    secondContent: '',
    editable: true,
    both: false
  })
  const handle = useRef(null)
  useEffect(() => {
    globalThis.__orcaEditor = {
      set: (next) => setState((previous) => ({ ...previous, ...next })),
      changes: [],
      secondChanges: [],
      links: [],
      insets: [],
      dismiss: () => handle.current?.dismissKeyboard()
    }
    document.body.setAttribute('data-ready', 'yes')
  }, [])
  // Each editor holds its own content, which is what makes the two-surface case a measurement:
  // sharing one prop would show the second's edit on the first whatever the document did.
  const editor = (key, withHandle, content, onChanged) =>
    createElement(MobileRichMarkdownEditor, {
      key,
      ref: withHandle ? handle : undefined,
      content,
      editable: state.editable,
      onChange: onChanged,
      onOpenLink: (url) => globalThis.__orcaEditor.links.push(url),
      onKeyboardInsetChange: (bottom) => globalThis.__orcaEditor.insets.push(bottom)
    })
  return createElement(
    SafeAreaProvider,
    { initialMetrics: METRICS },
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'row', height: '100vh' } },
      state.mounted
        ? createElement(
            'div',
            { id: 'first-surface', style: { flex: 1, display: 'flex', minHeight: 0 } },
            editor('first-' + state.generation, true, state.content, (next) => {
              globalThis.__orcaEditor.changes.push(next)
              setState((previous) => ({ ...previous, content: next }))
            })
          )
        : null,
      state.both
        ? createElement(
            'div',
            { id: 'second-surface', style: { flex: 1, display: 'flex', minHeight: 0 } },
            editor('second', false, state.secondContent, (next) => {
              globalThis.__orcaEditor.secondChanges.push(next)
              setState((previous) => ({ ...previous, secondContent: next }))
            })
          )
        : null
    )
  )
}

createRoot(document.getElementById('root')).render(createElement(Harness))
`

// Install ReactNativeWebView recorder before bundle: absence alone cannot prove editor JSON avoids shell bridge if bridge object never existed.
function installBridgeObjectRecorder() {
  globalThis.__orcaBridgeReads = []
  const bridge = {
    postMessage: (message) => globalThis.__orcaBridgeReads.push(`post ${String(message)}`)
  }
  Object.defineProperty(globalThis, 'ReactNativeWebView', {
    configurable: true,
    get: () => {
      globalThis.__orcaBridgeReads.push('read')
      return bridge
    }
  })
}

const bundles = mobileWebAppDependenciesPresent()
const describeEditor = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  // Keep entry under mobile/ so upward bare-import resolution finds component dependencies.
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'rich-markdown-render-'))
  const outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: {
      contents: PAGE_ENTRY,
      resolveDir: componentDir,
      loader: 'ts',
      sourcefile: 'rich-markdown-check.ts'
    },
    bundle: true,
    format: 'esm',
    outdir: outDir,
    entryNames: 'rich-markdown-check',
    target: ['es2022'],
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    // Match app plugin: barrel reexports LucideProvider absent from its context module.
    plugins: [lucideBarrelPlugin],
    // Prefer .web.jsx/.web.js or toolbar’s react-native-svg resolves Fabric and fails codegenNativeComponent.
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js'],
    // Match app’s RN shims for JSX-in-.js, process.env and Metro global; missing global made isFabric throw before mount.
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
    // Match shipped root reset: flex children need definite height on all three ancestors or editor paints at height zero.
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}` +
      `${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}</head>` +
      '<body><div id="root"></div>' +
      '<script type="module" src="/rich-markdown-check.js"></script></body></html>'
  )
  const served = await createBundleServer({
    outDir,
    cspHeader: await readShellCsp(),
    handleRequest: (_request, response, path) => {
      if (path !== IMAGE_PATH) {
        return false
      }
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PIXEL)
      return true
    }
  })
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

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await page.addInitScript(installBridgeObjectRecorder)
  await page.addInitScript(installCspViolationRecorder)
  await page.addInitScript(installListenerRecorder, { selector: '#editor' })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.ready === 'yes')
  await page.waitForSelector('#first-surface #editor')
  return { page, consoleErrors }
}

// Wait for whole innerHTML, not text: block changes preserve text and stale ranges caused Chromium IndexSizeError/WebKit timeout.
async function setContent(page, markdown, html) {
  await page.evaluate((next) => globalThis.__orcaEditor.set({ content: next }), markdown)
  await page.waitForFunction(
    (expected) => document.querySelector('#first-surface #editor')?.innerHTML === expected,
    html,
    { timeout: 15_000 }
  )
}

// For engine-serialized checklist/link markup, wait on target element instead of exact HTML.
async function setContentWithin(page, markdown, selector) {
  await page.evaluate((next) => globalThis.__orcaEditor.set({ content: next }), markdown)
  await page.waitForFunction(
    (expected) =>
      document.querySelector('#first-surface #editor')?.querySelector(expected) !== null,
    selector,
    { timeout: 15_000 }
  )
}

// Number paragraph seeds so content prop changes: identical input is a controller no-op after prior command.
// Nested ul-in-p serialization once returned unchanged text, leaving next command against previous document.
const bodyFor = (index) => `body text ${String(index)}`

function readSurface(page, surface = '#first-surface') {
  return page.evaluate((id) => document.querySelector(`${id} #editor`)?.innerHTML ?? null, surface)
}

async function select(page, how) {
  await page.evaluate((mode) => {
    const editor = document.querySelector('#first-surface #editor')
    editor.focus()
    const selection = window.getSelection()
    selection.removeAllRanges()
    const range = document.createRange()
    if (mode === 'all') {
      range.selectNodeContents(editor)
    } else {
      const text = editor.querySelector('p')?.firstChild ?? editor.firstChild
      range.setStart(text, 0)
      range.setEnd(text, 4)
    }
    selection.addRange(range)
  }, how)
}

async function press(page, label) {
  await page.locator(`[aria-label="${label}"]`).click()
}

describeEditor(
  'the rich Markdown editor on the page',
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

        it('mounts the document, reports ready through the seam and never touches the bridge', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            await setContent(page, '# Title', '<h1>Title</h1>')
            expect(await readSurface(page)).toBe('<h1>Title</h1>')
            // Initial markup proves document ready reached controller and pushed content through seam.
            expect(await page.evaluate(() => globalThis.__orcaBridgeReads)).toEqual([])
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
            // No editor occlusion report: screen’s web module already measures viewport, so reporting twice would lift bar twice.
            expect(await page.evaluate(() => globalThis.__orcaEditor.insets)).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('sits on the 16 px floor, which is what stops iOS zooming and never zooming back', async () => {
          const { page } = await openPage(browser)
          try {
            const size = await page.evaluate(
              () => getComputedStyle(document.querySelector('#first-surface #editor')).fontSize
            )
            // Assert at least floor: seam uses max(bodySize, floor), so larger theme text is valid.
            expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(FLOOR)
            // CSS variable must exist only on editor host; unscoped stylesheet would recolor every page screen.
            const variable = await page.evaluate(() => ({
              onRoot: getComputedStyle(document.documentElement)
                .getPropertyValue('--editor-surface')
                .trim(),
              onHost: getComputedStyle(document.querySelector('.orca-rich-markdown-document-host'))
                .getPropertyValue('--editor-surface')
                .trim()
            }))
            expect(variable.onHost).not.toBe('')
            expect(variable.onRoot).toBe('')
          } finally {
            await page.close()
          }
        }, 600_000)

        it('runs every one of the fifteen commands against the document', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            for (const [index, entry] of COMMANDS.entries()) {
              const body = bodyFor(index)
              await setContent(page, body, `<p>${body}</p>`)
              // Require command effect absent beforehand or undelivered command could pass on previous document.
              expect(
                await page.evaluate(
                  (selector) =>
                    document.querySelector('#first-surface #editor')?.querySelector(selector),
                  entry.expect
                ),
                `${entry.label} was already applied before it ran`
              ).toBeNull()
              await select(page, entry.select)
              await press(page, entry.label)
              await page.waitForFunction(
                (selector) =>
                  document.querySelector('#first-surface #editor')?.querySelector(selector) !==
                  null,
                entry.expect,
                { timeout: 15_000 }
              )
            }

            // Paragraph must undo another block type; it is a no-op on p.
            await setContent(page, '# Title', '<h1>Title</h1>')
            await select(page, 'all')
            await press(page, PARAGRAPH.label)
            await page.waitForFunction(
              () =>
                document.querySelector('#first-surface #editor')?.querySelector('h1') === null &&
                document.querySelector('#first-surface #editor')?.querySelector('p') !== null,
              null,
              { timeout: 15_000 }
            )

            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        // Both engines nest unordered list inside existing p; inline paragraph serialization once dropped bullet when saved.
        it('edits and selects under the shipped document style, which makes other text unselectable', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            await setContent(page, 'alpha', '<p>alpha</p>')
            const word = page.locator('#first-surface #editor p')
            await word.click()
            await page.keyboard.press('End')
            await page.keyboard.type(' bravo')
            await page.waitForFunction(
              () =>
                document.querySelector('#first-surface #editor p')?.textContent === 'alpha bravo'
            )
            // Use browser gesture: a scripted Range bypasses body user-select:none.
            await page.evaluate(() => window.getSelection()?.removeAllRanges())
            await word.dblclick()
            expect(await page.evaluate(() => window.getSelection()?.toString().trim())).not.toBe('')
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('reports a typed bullet list as a list, and renders that markdown back as one', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            const body = 'bullet round trip'
            await setContent(page, body, `<p>${body}</p>`)
            await select(page, 'all')
            await page.evaluate(() => {
              globalThis.__orcaEditor.changes.length = 0
            })
            await press(page, 'Bullet list')
            await page.waitForFunction(
              () => document.querySelector('#first-surface #editor')?.querySelector('ul') !== null,
              null,
              { timeout: 15_000 }
            )
            await page.waitForFunction(() => globalThis.__orcaEditor.changes.length > 0, null, {
              timeout: 15_000
            })
            // Require real ul-in-p nesting or case would exercise flat list shape serializer already handled.
            expect(
              await page.evaluate(
                () =>
                  document.querySelector('#first-surface #editor ul')?.parentElement?.tagName ??
                  null
              )
            ).toBe('P')
            expect(await page.evaluate(() => globalThis.__orcaEditor.changes.at(-1))).toBe(
              `- ${body}`
            )

            // Round-trip saved Markdown through different content first; resetting identical prop would be a no-op.
            await setContent(page, 'plain again', '<p>plain again</p>')
            await setContent(page, `- ${body}`, `<ul><li><p>${body}</p></li></ul>`)

            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('answers Link and Image from a modal rather than from a prompt that returns null', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            for (const [index, entry] of URL_COMMANDS.entries()) {
              const body = bodyFor(index)
              await setContent(page, body, `<p>${body}</p>`)
              await select(page, 'word')
              await press(page, entry.label)
              // Phone shells lack window.prompt delegate, so URL commands need modal to avoid silent no-op.
              await expect
                .poll(() => page.locator(`text=${entry.title}`).count(), { timeout: 15_000 })
                .toBeGreaterThan(0)
              const field = page.locator('input[placeholder="https://"]')
              await field.waitFor({ state: 'visible', timeout: 15_000 })
              await field.fill(`${origin}${entry.path}`)
              await page.locator('text=Insert').first().click()
              await page.waitForFunction(
                (selector) =>
                  document.querySelector('#first-surface #editor')?.querySelector(selector) !==
                  null,
                entry.expect,
                { timeout: 15_000 }
              )
              expect(
                await page
                  .locator(`#first-surface #editor ${entry.expect}`)
                  .getAttribute(entry.label === 'Link' ? 'href' : 'src')
              ).toBe(`${origin}${entry.path}`)
            }
            // Insertion precedes loading; require image paint so policy refusal still fails.
            await expect
              .poll(
                () =>
                  page.evaluate(
                    () => document.querySelector('#first-surface #editor img')?.naturalWidth ?? 0
                  ),
                { timeout: 15_000 }
              )
              .toBeGreaterThan(0)
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)

        it('reports one change per checkbox tap and one per inline code', async () => {
          const { page } = await openPage(browser)
          try {
            await setContentWithin(page, '- [ ] one', 'input[type="checkbox"]')
            await page.evaluate(() => {
              globalThis.__orcaEditor.changes.length = 0
            })
            await page.locator('#first-surface #editor input[type="checkbox"]').first().click()
            await page.waitForFunction(() => globalThis.__orcaEditor.changes.length > 0)
            // Single tap emits click/input/change; each once reported duplicate change.
            expect(await page.evaluate(() => globalThis.__orcaEditor.changes)).toHaveLength(1)
            expect(await page.evaluate(() => globalThis.__orcaEditor.changes[0])).toContain('[x]')

            await setContent(page, bodyFor(0), `<p>${bodyFor(0)}</p>`)
            await select(page, 'word')
            await page.evaluate(() => {
              globalThis.__orcaEditor.changes.length = 0
            })
            await press(page, 'Inline code')
            await page.waitForFunction(() => globalThis.__orcaEditor.changes.length > 0)
            expect(await page.evaluate(() => globalThis.__orcaEditor.changes)).toHaveLength(1)
          } finally {
            await page.close()
          }
        }, 600_000)

        it('opens a link through the host rather than navigating the page', async () => {
          const { page } = await openPage(browser)
          try {
            await setContentWithin(page, '[a](https://example.com/a)', 'a[href]')
            await page.locator('#first-surface #editor a').first().click()
            await page.waitForFunction(() => globalThis.__orcaEditor.links.length > 0)
            expect(await page.evaluate(() => globalThis.__orcaEditor.links)).toEqual([
              'https://example.com/a'
            ])
            expect(page.url()).toBe(`${origin}/`)
          } finally {
            await page.close()
          }
        }, 600_000)

        it('removes the first editor listeners and mounts a working second document', async () => {
          const { page, consoleErrors } = await openPage(browser)
          const listeners = () => page.evaluate(() => globalThis.__orcaListeners.snapshot())
          try {
            await setContent(page, 'first document', '<p>first document</p>')
            const first = await listeners()
            const firstOwned = Object.fromEntries(
              Object.entries(first).filter(([key]) => key.startsWith('element '))
            )
            expect(
              Object.keys(firstOwned)
                .map((key) => key.split(' ').at(-1))
                .sort()
            ).toEqual(['change', 'click', 'input', 'keydown'])
            expect(Object.values(firstOwned)).toEqual([1, 1, 1, 1])

            // Baseline after first mount cycle: RN-Web installs permanent responder listeners on first View, outside per-mount disposal.
            await page.evaluate(() => globalThis.__orcaEditor.set({ mounted: false }))
            await page.waitForFunction(() => document.querySelector('#first-surface') === null)
            await expect
              .poll(
                async () =>
                  Object.keys(await listeners()).filter((key) => key.startsWith('element ')),
                { timeout: 5_000 }
              )
              .toEqual([])
            const afterOneCycle = await listeners()
            // Require recorder saw real listeners so empty snapshots cannot pass as no leak.
            expect(Object.keys(afterOneCycle).length).toBeGreaterThan(0)

            await page.evaluate(() => {
              globalThis.__orcaEditor.set({ mounted: true, generation: 1 })
            })
            await page.waitForSelector('#first-surface #editor')
            await setContent(page, 'second document', '<p>second document</p>')
            await select(page, 'all')
            await press(page, 'Bold')
            await page.waitForFunction(
              () =>
                document.querySelector('#first-surface #editor')?.querySelector('b,strong') !== null
            )

            const second = await listeners()
            const globals = Object.fromEntries(
              Object.entries(second).filter(([key]) => !key.startsWith('element '))
            )
            expect(globals).toEqual(afterOneCycle)
            const secondOwned = Object.fromEntries(
              Object.entries(second).filter(([key]) => key.startsWith('element '))
            )
            expect(
              Object.keys(secondOwned)
                .map((key) => key.split(' ').at(-1))
                .sort()
            ).toEqual(['change', 'click', 'input', 'keydown'])
            expect(Object.values(secondOwned)).toEqual([1, 1, 1, 1])
            expect(Object.keys(secondOwned).some((key) => key in firstOwned)).toBe(false)
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
            expect(
              await page.evaluate(
                () => document.querySelectorAll('#orca-rich-markdown-document-style').length
              )
            ).toBe(1)
          } finally {
            await page.close()
          }
        }, 600_000)

        it('gives two editors on one page their own surfaces', async () => {
          const { page, consoleErrors } = await openPage(browser)
          try {
            await setContent(page, 'first only', '<p>first only</p>')
            await page.evaluate(() =>
              globalThis.__orcaEditor.set({ both: true, secondContent: 'second only' })
            )
            await page.waitForSelector('#second-surface #editor')
            // Editor IDs repeat across hosts: document-wide lookup would bind second editor to first surface/listeners.
            await page.waitForFunction(() =>
              (document.querySelector('#second-surface #editor')?.textContent ?? '').includes(
                'second only'
              )
            )
            expect(await readSurface(page, '#first-surface')).toContain('first only')
            expect(await readSurface(page, '#second-surface')).not.toContain('first only')

            await page.evaluate(() => {
              const editor = document.querySelector('#second-surface #editor')
              editor.innerHTML = '<p>typed in the second</p>'
              editor.dispatchEvent(new Event('input', { bubbles: true }))
            })
            await page.waitForFunction(() =>
              globalThis.__orcaEditor.secondChanges.includes('typed in the second')
            )
            // Require edit reaches second host without reporting through or changing first editor.
            expect(await page.evaluate(() => globalThis.__orcaEditor.changes)).not.toContain(
              'typed in the second'
            )
            expect(await readSurface(page, '#first-surface')).toContain('first only')
            expect(consoleErrors).toEqual([])
          } finally {
            await page.close()
          }
        }, 600_000)
      })
    }
  },
  1_800_000
)
