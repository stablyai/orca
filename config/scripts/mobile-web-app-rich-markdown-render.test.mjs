/**
 * The rich Markdown editor in the page, in a real browser, under the policy the shell ships.
 *
 * The native component puts a hand-written document inside a `WebView` and talks to it over
 * `postMessage` and `injectJavaScript`. The page has no WebView, so it mounts the same modules and
 * calls them. That makes four claims this file measures rather than asserts: that all fifteen
 * toolbar commands change the document under the shipped header with no violation; that `ready`
 * and `change` reach the component through its own seam and never through the shell's bridge
 * object; that a remount leaves nothing of the first mount behind (rulings 20 and 21); and that the
 * surface is on the 16 px floor and the two URL commands are answered by a modal rather than by the
 * `null` both shells return from `window.prompt`.
 *
 * Both engines, because the shell is WKWebView on one platform and a Chromium WebView on the other,
 * and `document.execCommand` — which the whole program is built on — is the engine's.
 */
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { MOBILE_WEB_APP_ROOT_RESET, lucideBarrelPlugin } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { textInputFontSizeFloor } from './mobile-web-app-text-input-font-size-seam.mjs'
import {
  createBundleServer,
  installCspViolationRecorder,
  installListenerRecorder,
  installSchedulerRecorder,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))
const componentDir = join(mobileDir, 'src/components')

/**
 * The surface's floor, read out of the seam's own module rather than retyped.
 *
 * The number was a literal `16` under a comment claiming it was read, which is the shape the seam
 * exists to prevent: a theme that raised the body size past the floor would move what the page
 * computes and leave this asserting the old number. `textInputFontSizeFloor` is the same reader the
 * closure census uses, and it throws rather than defaulting when the seam is gone.
 */
const FLOOR = textInputFontSizeFloor(mobileDir)

/** Every command, with how to set the document up for it and what it must produce. */
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

/** Paragraph is the fifteenth, and it is the only one whose proof is a document it undoes. */
const PARAGRAPH = { label: 'Body', command: 'paragraph' }

/**
 * The two that need a URL, and the element each inserts.
 *
 * The image's URL is this server's own, because an inserted `<img>` is fetched: a name that does
 * not resolve put a load failure in the console, and WebKit reports it where chromium does not.
 * Serving it is also the stronger reading — the element the command inserted actually painted
 * under the shipped policy rather than merely appearing in the markup.
 */
const IMAGE_PATH = '/inserted.png'
const URL_COMMANDS = [
  { label: 'Link', title: 'Link URL', path: '/linked', expect: 'a[href]' },
  { label: 'Image', title: 'Image URL', path: IMAGE_PATH, expect: 'img' }
]

/** One transparent pixel, served for the image the Image command inserts. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

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
 * Not a re-implementation. The controller, the mount, the document's own modules and the toolbar
 * are all the behaviour under test, and a probe that called `runCommand` itself would prove nothing
 * about any of them.
 *
 * `content` is fed back from `onChange`, which is what `MarkdownReader` does: a harness that held
 * the prop still would have the controller replacing the document under every edit.
 */
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

/**
 * A recorder over `window.ReactNativeWebView`, installed before the bundle runs.
 *
 * Ruling 19's claim on the page is an absence, and an absence needs an instrument: on the shell
 * that object is the bridge's, so an editor message posted through it would put editor JSON into
 * the bridge's own channel. Defined rather than left undefined, so "the page never reaches for it"
 * is measured against something that would have answered.
 */
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
  // Inside mobile/ rather than the system temp dir: the entry resolves the component beside it,
  // and esbuild resolves a bare specifier from the importer upward.
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
    // The barrel re-exports a `LucideProvider` its own context module does not export, which is the
    // same shape the app bundle carries this plugin for.
    plugins: [lucideBarrelPlugin],
    // `.web.jsx` and `.web.js` are here for the reason the app bundle has them: without them
    // `react-native-svg`, which the toolbar's icons pull in, resolves its Fabric components and
    // fails on `codegenNativeComponent`.
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js'],
    // Four of `MOBILE_WEB_APP_SHIMS`, because this entry reaches the same React Native modules the
    // app bundle does: RN ships untranspiled JSX in `.js`, reads `process.env` at module scope, and
    // assumes a Metro `global` — measured, `isFabric` threw `global is not defined` before the page
    // mounted at all, and every case in this file failed at `data-ready`.
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
    // The root reset the shipped document carries: every box below the mount is `flex: 1`, so
    // without a definite height on all three the editor measures 0 and paints nothing.
    `<!doctype html><html><head><meta charset="utf-8">${MOBILE_WEB_APP_ROOT_RESET}</head>` +
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
    // This run's directory only: `mobile/.tmp` is a shared ignored root and another suite may hold
    // one of its own.
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
  await page.addInitScript(installListenerRecorder)
  await page.addInitScript(installSchedulerRecorder)
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.ready === 'yes')
  await page.waitForSelector('#first-surface #editor')
  return { page, consoleErrors }
}

/**
 * Sets the content through the component's prop and waits for the document to hold that markup.
 *
 * The oracle is the surface's whole `innerHTML`, not its text. Text cannot tell one block type from
 * another — `### body text here` and `body text here` read the same — so a run that waited on text
 * passed while the document was still the one the command before it left, and the next case selected
 * a range inside an element that was not there any more. Measured: `setEnd` threw
 * `IndexSizeError` in chromium and the fifteen-command loop timed out in webkit.
 */
async function setContent(page, markdown, html) {
  await page.evaluate((next) => globalThis.__orcaEditor.set({ content: next }), markdown)
  await page.waitForFunction(
    (expected) => document.querySelector('#first-surface #editor')?.innerHTML === expected,
    html,
    { timeout: 15_000 }
  )
}

/**
 * The same, for the two documents whose markup this file does not write down.
 *
 * A checklist and a link render nested markup whose exact serialization is the engine's, so the
 * wait names the element the case is about to act on instead.
 */
async function setContentWithin(page, markdown, selector) {
  await page.evaluate((next) => globalThis.__orcaEditor.set({ content: next }), markdown)
  await page.waitForFunction(
    (expected) =>
      document.querySelector('#first-surface #editor')?.querySelector(expected) !== null,
    selector,
    { timeout: 15_000 }
  )
}

/**
 * The plain paragraph a command case starts from, numbered so no two are the same.
 *
 * The content prop is what resets the document, and the controller only pushes when it differs
 * from what the editor last reported. Re-setting the same string is therefore a no-op, and the
 * next command would run against the document the one before it left. Both list commands used to
 * make that worse rather than better: `insertUnorderedList` nests the `<ul>` inside the `<p>` it
 * was given on both engines, and the serializer read the paragraph inline, so pressing it reported
 * the paragraph's own text back unchanged.
 */
const bodyFor = (index) => `body text ${String(index)}`

/** The surface's markup, which is what every command is read off. */
function readSurface(page, surface = '#first-surface') {
  return page.evaluate((id) => document.querySelector(`${id} #editor`)?.innerHTML ?? null, surface)
}

/** Selects the whole surface, or its first word, through the browser's own selection. */
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

/** One toolbar press, as a user makes it. */
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
            // The document's `ready` is what made the controller push that content, so the markup
            // above is the seam working end to end.
            expect(await page.evaluate(() => globalThis.__orcaBridgeReads)).toEqual([])
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
            // Never: the screen's own `keyboard-occlusion.web.ts` measures the same viewport with
            // the same formula, and a report here would lift its bar twice.
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
            // At or above, not equal to the floor: the seam is `Math.max(bodySize, floor)`, so a
            // theme whose body size passes the floor raises what the page computes and still keeps
            // the rule. Equality against the floor would be the stale literal again, one module
            // further away.
            expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(FLOOR)
            // And the sheet reaches only the editor. The oracle is one of the document's own
            // variables, which its `:root` rule declares and everything under it reads: set on the
            // host, and nowhere else. A sheet appended unscoped would have it on the root element,
            // where it would recolour every screen the shell can show.
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
              // The precondition each command needs: what it is about to produce is not there yet.
              // Without it a command the controller never delivered would pass on the document the
              // one before it left.
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

            // Paragraph is the fifteenth and the only one whose effect is to undo another's: it is
            // a true no-op on a `<p>`, which is why a run that starts from one measures nothing.
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

        /**
         * A list typed on the surface, read back as markdown, and rendered from that markdown.
         *
         * `insertUnorderedList` puts the `<ul>` inside the `<p>` it was given rather than replacing
         * it — measured here on WebKit 26.4 and Chromium 147 both — and a serializer that read such
         * a paragraph inline reported its own text with no marker, so the bullet the user pressed
         * was gone the moment the host saved what the document reported.
         */
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
            // The precondition: the engine really did nest the list inside the paragraph. An engine
            // that replaced the paragraph would leave this case measuring the flat shape, which the
            // serializer never got wrong.
            expect(
              await page.evaluate(
                () =>
                  document.querySelector('#first-surface #editor ul')?.parentElement?.tagName ??
                  null
              )
            ).toBe('P')
            // What the host would save.
            expect(await page.evaluate(() => globalThis.__orcaEditor.changes.at(-1))).toBe(
              `- ${body}`
            )

            // And the trip closes: that markdown comes back in as a list rather than a paragraph.
            // Through a different document first, because the prop already holds this string and
            // re-setting the same one is a no-op.
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
              // The seam both shells could not answer: neither implements the delegate
              // `window.prompt` needs, so on the phone these two commands silently do nothing.
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
            }
            // The inserted image painted: `naturalWidth` is 0 for an element the browser refused
            // or never fetched, which is what a policy that did not admit it would leave.
            expect(
              await page.evaluate(
                () => document.querySelector('#first-surface #editor img')?.naturalWidth ?? 0
              )
            ).toBeGreaterThan(0)
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
            // One tap raises click, input and change, and each of the three used to report.
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

        it('leaves no listener, timer or frame of the first mount in the second', async () => {
          const { page, consoleErrors } = await openPage(browser)
          const listeners = () => page.evaluate(() => globalThis.__orcaListeners.snapshot())
          try {
            await setContent(page, 'first document', '<p>first document</p>')

            // A first mount installs listeners no dispose can take off — react-native-web's
            // responder system arms itself on the first `View` the page renders — so the baseline a
            // per-mount leak would move is the snapshot after one whole cycle, not before it.
            await page.evaluate(() => globalThis.__orcaEditor.set({ mounted: false }))
            await page.waitForFunction(() => document.querySelector('#first-surface') === null)
            const afterOneCycle = await listeners()
            // The precondition that makes the comparison below non-vacuous: the recorder is reading
            // real listeners, so a snapshot of nothing cannot pass as a snapshot of no leak.
            expect(Object.keys(afterOneCycle).length).toBeGreaterThan(0)

            await page.evaluate(() => {
              globalThis.__orcaScheduler.watching = true
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

            // The second mount is live, and the page is listening to exactly what it was after the
            // first cycle. A mount that registered anything of its own would show up here.
            expect(await listeners()).toEqual(afterOneCycle)
            expect(await page.evaluate(() => globalThis.__orcaScheduler.leaked)).toEqual([])
            expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
            expect(consoleErrors).toEqual([])
            // The sheet stays in the head across mounts, and there is one of it.
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
            // The markup's id is the same in both hosts, so a page-wide read would have handed the
            // second document the first one's surface: one would be empty and the other would hold
            // both documents' content and both documents' listeners.
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
            // The edit reached the second editor's own host, and the first document neither
            // reported it nor lost its content.
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
