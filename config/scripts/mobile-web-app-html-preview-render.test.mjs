/**
 * The HTML preview's sealed frame, in a real browser under the shipped policy, on both engines.
 *
 * The frame holds an agent-produced artifact inside the page's own document, so every claim about
 * what it cannot do has to be measured rather than reasoned about — and every one of those claims is
 * an absence, which is also what a frame that never rendered reports. So each case runs against a
 * no-header control where the same artifact does the thing: the script runs, the remote subresources
 * are fetched, the navigation happens. Without those controls a preview that failed to load would
 * pass every assertion here.
 *
 * WebKit as well as Chromium, because the iOS shell is WKWebView and the two disagree: a `blob:`
 * frame that Chromium admits under `frame-src blob:` is refused in WebKit by the
 * `frame-ancestors 'none'` it inherits. `srcdoc` is what both admit under the policy that already
 * ships, which is why this costs no CSP change and why a case below pins `frame-src 'none'` as still
 * shipped.
 *
 * The paint oracle is a pixel rather than a read inside the frame: the frame is an opaque origin, and
 * WebKit refuses to evaluate in one, so reading its DOM would make the instrument engine-dependent.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { PNG } from 'pngjs'
import { chromium, webkit } from 'playwright-core'
import { lucideBarrelPlugin } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from './mobile-web-app-render-harness.mjs'
import { describePreviewFrame, untilAborted } from './mobile-web-app-preview-frame-diagnosis.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

/** Where the preview sits once mounted, which is what the pixel oracle samples. */
const FRAME_PROBE = { x: 60, y: 200, width: 4, height: 4 }
/** The artifact fills itself with this, so one pixel says the frame parsed and painted. */
const ARTIFACT_RGB = '0,128,255'
/** The page behind the frame, so a frame that painted nothing reads as this instead. */
const PAGE_RGB = '17,17,17'

/**
 * The page under test: the real web sibling, mounted by react-native-web, with nothing else on it.
 *
 * The component is imported rather than reimplemented, and `resolveExtensions` puts `.web.tsx` first
 * so this is the file the bundle ships. `renderSource` is a marker the Source case looks for.
 */
const ENTRY_SOURCE = `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Text } from 'react-native'
import { MobileHtmlPreview, MOBILE_HTML_PREVIEW_SANDBOX } from './MobileHtmlPreview'

window.__sandbox = MOBILE_HTML_PREVIEW_SANDBOX
window.__mount = (html, sandboxOverride) => {
  const host = document.getElementById('root')
  createRoot(host).render(
    createElement(MobileHtmlPreview, {
      html,
      renderSource: () => createElement(Text, null, 'SOURCE_TAB_RENDERED')
    })
  )
  // A control arm needs a frame the product would never build -- one with allow-scripts -- so that
  // "the script did not run" can be told apart from "the fixture has no script". Built here rather
  // than through a prop, because the product takes no such prop and must not grow one for a test.
  //
  // Awaited rather than read straight away: createRoot().render() commits on React's own schedule,
  // and reading the element synchronously finds nothing.
  if (sandboxOverride === null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    // Twenty seconds for a commit that takes a frame or two here: the reads this rig makes all
    // settle late on a loaded runner, which is the whole reason nothing below is timed.
    const deadline = Date.now() + 20000
    const apply = () => {
      const frame = host.querySelector('iframe')
      if (frame) {
        // A new element rather than the live one relaxed, because a live frame cannot be relaxed:
        // sandbox flags are fixed on a browsing context when it is created, and Chrome 152 keeps the
        // original ones through a srcdoc reassignment while still parsing the new document. An arm
        // that ran on such a frame reports the sealed behaviour under a widened name and passes for
        // the wrong reason, which is exactly what CI read while Chromium 147 here honoured the
        // relaxation. The clone gets its own context from creation, the way the product does it:
        // React sets the attribute before the element is inserted, and never afterwards.
        const widened = frame.cloneNode(false)
        widened.setAttribute('sandbox', sandboxOverride)
        widened.srcdoc = html
        // Resolved on the document the insertion commits, not on the insertion.
        widened.addEventListener('load', () => resolve(), { once: true })
        frame.replaceWith(widened)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('the preview never mounted a frame to override'))
        return
      }
      requestAnimationFrame(apply)
    }
    apply()
  })
}
`

/** Where the artifact's links and subresources point, and the origin that counts what it asked for. */
let foreignOrigin = null
const foreignHits = []
let foreign = null

/**
 * One artifact, with every escape route a hostile one would try.
 *
 * `extra.head` and `extra.body` let a case add a `<meta refresh>` or a script without a second
 * fixture, so the thing under test is the only difference between the arms.
 */
function artifact(extra = {}, nonce = 'n0') {
  // Every foreign URL carries this arm's nonce, because a closed page's requests can still land and
  // a hit list shared across arms would report the previous one's fetches as this one's.
  const tag = `?n=${nonce}`
  return `<!doctype html><html><head><title>ARTIFACT</title>
<style>html,body{margin:0;height:100%;background:rgb(${ARTIFACT_RGB})}
#bg{background-image:url("${foreignOrigin}/css-bg.png${tag}")}
@font-face{font-family:probe;src:url("${foreignOrigin}/probe.woff2${tag}")}
#fonted{font-family:probe}</style>${extra.head ?? ''}</head><body>
<h1 id="marker">ARTIFACT_RENDERED</h1><div id="bg">b</div><div id="fonted">f</div>
<img id="remote" src="${foreignOrigin}/img.png${tag}" />
<a id="toplink" href="${foreignOrigin}/tapped.html${tag}" target="_top">tap</a>
<a id="blanklink" href="${foreignOrigin}/blank.html${tag}" target="_blank">window</a>
<a id="rootlink" href="/" target="_top">root</a>
<a id="emptylink" href="" target="_top">empty</a>
<form id="topform" action="${foreignOrigin}/form.html" target="_top" method="get"><button id="submit">go</button></form>
${extra.body ?? ''}</body></html>`
}

let nonceCounter = 0

/** The inline script every arm carries, so "it did not run" is about the fence and not the fixture. */
const ARTIFACT_SCRIPT = `<script>
  window.__ran = 1;
  document.title = 'SCRIPT_RAN';
  document.getElementById('marker').textContent = 'SCRIPT_RAN';
  fetch('${'${foreignOrigin}'}/fetched.json').catch(() => {});
  try { window.top.location.href = '${'${foreignOrigin}'}/by-script.html' } catch (error) { window.__threw = error.name }
</script>`

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch = null
let outDir = null
let shippedCsp = null

const browsers = {}
/**
 * Two servers over one bundle rather than one server with a switch: the policy is a response header
 * the harness reads once per server, and a control arm that shared a server with the sealed arm
 * would be one race away from measuring the wrong header.
 */
let sealedServer = null
let openServer = null
const origins = {}

beforeAll(async () => {
  shippedCsp = await readShellCsp()
  if (!bundles) {
    return
  }
  foreignHits.length = 0
  foreign = createServer((request, response) => {
    foreignHits.push(request.url)
    if (request.url.endsWith('.png')) {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
          'base64'
        )
      )
      return
    }
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
    response.end('<html><body>FOREIGN</body></html>')
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  foreignOrigin = `http://127.0.0.1:${String(foreign.address().port)}`

  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'html-preview-render-'))
  outDir = join(scratch, 'bundle')
  await mkdir(outDir, { recursive: true })
  await esbuild.build({
    absWorkingDir: mobileDir,
    stdin: {
      contents: ENTRY_SOURCE,
      resolveDir: join(mobileDir, 'src/components'),
      loader: 'tsx',
      sourcefile: 'html-preview-check.tsx'
    },
    bundle: true,
    format: 'iife',
    outfile: join(outDir, 'html-preview-check.js'),
    target: ['es2022'],
    jsx: 'automatic',
    logLevel: 'silent',
    // The page's own icon shim, imported rather than copied: `lucide-react-native` imports a
    // `LucideProvider` its context module does not export, so the toolbar's icons do not link
    // without it.
    plugins: [lucideBarrelPlugin],
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    // The web sibling is what the page runs; naming the native file would measure the module that
    // needs `react-native-webview` to exist. `.web.jsx`/`.web.js` are in the list for the same reason
    // the real bundle has them: without them `react-native-svg`, which the toolbar's icons pull in,
    // resolves its Fabric components and fails on `codegenNativeComponent`.
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
      `<body style="margin:0;background:rgb(${PAGE_RGB})">` +
      // A flex column at the viewport's height: the component's outermost `View` is `flex: 1`, and
      // in a plain block container that resolves to no height at all and the frame never paints.
      '<div id="root" style="display:flex;flex-direction:column;height:100vh"></div>' +
      '<script src="/html-preview-check.js"></script></body></html>'
  )
  const sealed = await createBundleServer({ outDir, cspHeader: shippedCsp })
  sealedServer = sealed.server
  origins.shipped = sealed.origin
  const bare = await createBundleServer({ outDir, cspHeader: null })
  openServer = bare.server
  origins.none = bare.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browsers.chromium = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  // No override for WebKit: there is no system WebKit for Playwright to borrow, so a runner without
  // the download skips rather than testing Chromium twice under another name.
  browsers.webkit = await webkit.launch({ headless: true }).catch(() => null)
}, 300_000)

afterAll(async () => {
  await browsers.chromium?.close()
  await browsers.webkit?.close()
  sealedServer?.close()
  openServer?.close()
  foreign?.close()
  if (scratch) {
    // This run's directory only: `mobile/.tmp` is a shared ignored root and another suite may hold
    // one of its own.
    await rm(scratch, { recursive: true, force: true })
  }
})

/**
 * Mounts the preview with one artifact and reports everything a case can assert on.
 *
 * `csp: null` is the control arm. The foreign origin's hit list is reset per open, so what it holds
 * is this artifact's doing.
 */
async function open(
  browser,
  {
    extra = {},
    csp = 'shipped',
    sandbox,
    act,
    expectNavigation = null,
    frameReady = 'artifact',
    signal
  } = {}
) {
  const origin = csp === 'shipped' ? origins.shipped : origins.none
  nonceCounter += 1
  const nonce = `n${String(nonceCounter)}`
  // Read here and carried as a string: asked for at the abort it lost its race with teardown and
  // printed "browser unknown" in the CI log this diagnostic exists for.
  const browserVersion = browser.version()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const navigations = []
  const popups = []
  page.on('popup', (popup) => {
    popups.push(popup.url())
    void popup.close().catch(() => {})
  })
  // The shell's navigation delegate, stood in for: Playwright is not the shell, so a top-frame
  // navigation is recorded with the frame that asked and aborted. That count is exactly what the
  // shell's `onExternalNavigation` would be handed.
  const record = (route) => {
    const request = route.request()
    if (request.isNavigationRequest()) {
      const main = request.frame() === page.mainFrame()
      navigations.push({
        url: request.url(),
        foreign: request.url().startsWith(foreignOrigin),
        main
      })
      // A frame navigating itself is counted and then left alone: aborting it would make "the frame
      // stayed on the artifact" true by the rig's own doing.
      if (main) {
        return void route.abort()
      }
    }
    return void route.continue()
  }
  await page.route(`${foreignOrigin}/**`, record)
  // The shell page's violations, and only those: an artifact's own listener would have to run, and
  // the fence under test is that nothing in the artifact runs.
  await page.addInitScript(() => {
    window.__violations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`)
    })
  })
  await page.goto(`${origin}/preview`, { waitUntil: 'load' })
  // Registered after the page's own load, not before it: this handler aborts main-frame navigations
  // and the initial `goto` is one. `href="/"` and `href=""` inside an artifact resolve against the
  // embedder's base, so a tap on either asks to navigate the top frame to the shell's own document.
  // The rig has no shell, so what this pins is the request the shell is handed; refusing it is
  // `MobileWebShellDroppedNavigationTest`'s "refuses every navigation to the document that the shell
  // did not ask for" and its `checkNavigationVerdict` twin on iOS.
  await page.route(`${origin}/**`, record)
  // `sandbox` undefined is the product's own token, which is what every non-control case runs.
  await page.evaluate(
    ([html, override]) => window.__mount(html, override),
    [artifact(extra, nonce), sandbox ?? null]
  )
  // Named in every diagnostic, because the log shows the case and not which of its arms spoke.
  const arm = `arm csp=${csp} sandbox=${sandbox ?? 'product'} frameReady=${frameReady} nonce=${nonce}`
  const artifactFrame = await waitForLoadedFrame(page, frameReady, signal, browserVersion, arm)
  const frames = () => page.frames().filter((frame) => frame !== page.mainFrame())
  // Sampled before the action as well as after: a case that taps a link is asking what the tap
  // produced, and by then the top frame is mid-navigation and the iframe has blanked to its own
  // background. So the precondition "there was a rendered artifact to tap" is this reading, and the
  // one below is only meaningful for a case that did nothing.
  const pixelBefore = await probePixel(page)
  const readToggles = async () =>
    await page
      .evaluate(() =>
        [...document.querySelectorAll('[role="tab"]')].map((one) => ({
          label: one.getAttribute('aria-label'),
          selected: one.getAttribute('aria-selected')
        }))
      )
      .catch(() => null)
  // Sampled before the action as well, because the toggle's whole claim is that it changes.
  const togglesBefore = await readToggles()
  if (act) {
    await act({ page, frame: frames()[0] ?? null })
  }
  // Every arm settles, acting or not: an artifact can start a navigation with no tap behind it --
  // `<meta http-equiv="refresh">` is one -- and the arms that pin zero were reading their counters
  // while that was still in flight.
  await settleAfterMount(page, navigations, expectNavigation, signal, {
    frame: artifactFrame,
    browserVersion,
    arm
  })
  const result = {
    page,
    pixelBefore,
    pixel: await probePixel(page),
    declaredSandbox: await page.evaluate(() => window.__sandbox),
    // What the toolbar emits into the DOM, not what the component was handed: react-native-web
    // forwards `aria-*` and drops `accessibilityState` on the floor, so a selected state that reads
    // fine in the test renderer can reach a screen reader as nothing at all.
    togglesBefore,
    toggles: await readToggles(),
    // The attribute on the element the component actually rendered, not the constant it exports: a
    // literal in the JSX would leave the constant correct and the frame unsealed, which is what the
    // control run for this file did before this reading existed.
    mountedSandbox: await page
      .evaluate(() => document.querySelector('iframe')?.getAttribute('sandbox') ?? null)
      .catch(() => null),
    frameCount: frames().length,
    // Reported so a pixel that read the page instead of the frame names the layout rather than
    // looking like a frame that refused to load.
    frameBox: await page
      .evaluate(() => {
        const frame = document.querySelector('iframe')
        if (!frame) {
          return null
        }
        const box = frame.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })
      .catch(() => null),
    // Reported, never asserted on: a `srcdoc` frame's URL reads `about:srcdoc` here and empty on
    // CI's browser, so nothing may be decided by it.
    frameUrl: frames()[0]?.url() ?? null,
    // The element's own attributes, which is where "the artifact is parsed inside the frame rather
    // than fetched into it" actually lives.
    mountedSrcDoc: await page
      .evaluate(() => document.querySelector('iframe')?.getAttribute('srcdoc') ?? null)
      .catch(() => null),
    mountedSrc: await page
      .evaluate(() => document.querySelector('iframe')?.getAttribute('src') ?? null)
      .catch(() => null),
    inside: await (frames()[0]
      ?.evaluate(() => ({
        marker: document.getElementById('marker')?.textContent ?? null,
        title: document.title,
        ran: window.__ran ?? 0,
        threw: window.__threw ?? null,
        // The frame's own list, not the embedder's: `securitypolicyviolation` does not cross frames,
        // and the page's init script installs the same collector in every one.
        violations: window.__violations ?? null
      }))
      .catch(() => null) ?? Promise.resolve(null)),
    topNavigations: navigations.filter((one) => one.main && one.foreign).length,
    ownOriginTopNavigations: navigations.filter((one) => one.main && !one.foreign).length,
    // What the frame asked for itself at the embedder's origin, which is a different escape from a
    // top-frame request and is refused by a different line of the policy.
    ownOriginFrameNavigations: navigations.filter((one) => !one.main && !one.foreign).length,
    popups: popups.length,
    // This arm's fetches only, by nonce: the paths, with the nonce stripped, so a case reads the
    // subresource rather than the bookkeeping.
    foreignHits: foreignHits
      .filter((one) => one.includes(`n=${nonce}`))
      .map((one) => one.split('?')[0]),
    violations: await page.evaluate(() => window.__violations),
    body: await page.evaluate(() => document.body.innerText)
  }
  await page.close()
  return result
}

for (const engine of ['chromium', 'webkit']) {
  describeRender(
    `the HTML preview's sealed frame on ${engine}`,
    () => {
      const browser = () => {
        const one = browsers[engine]
        if (!one) {
          throw new Error(`${engine} is not installed for playwright-core`)
        }
        return one
      }

      it('paints the artifact under the policy the shell already ships', async (ctx) => {
        const read = await open(browser(), { signal: ctx.signal })
        expect(read.frameCount).toBe(1)
        // The artifact is the frame's own document, not something it went and fetched: `srcdoc`
        // carries it and there is no `src` at all. Read from the element rather than from the
        // frame's URL, which is `about:srcdoc` on one browser and empty on another.
        expect(read.mountedSrcDoc).toContain('ARTIFACT_RENDERED')
        expect(read.mountedSrc).toBeNull()
        // The rendered frame carries the constant, so the token case below is about the frame the
        // page mounts rather than about a string nothing reads.
        expect(read.mountedSandbox).toBe(read.declaredSandbox)
        expect(read.mountedSandbox).toBe('allow-top-navigation-by-user-activation')
        // The pixel, not a read inside the frame: the frame is an opaque origin.
        expect(read.pixel).toBe(ARTIFACT_RGB)
        // The shell page's own violations, which is all this can be: `securitypolicyviolation` does
        // not cross into a frame, so an empty list here says the embedder raised none -- not that the
        // frame raised none. What the frame's inherited policy did to the frame is measured where it
        // can be: the pixel above is its inline `<style>` applying, and the counting server in the
        // case below is its `img-src` and `font-src`.
        expect(read.violations).toEqual([])
      }, 120_000)

      it('does not run the artifact, behind two fences either of which would hold', async (ctx) => {
        const sealed = await open(browser(), { extra: { body: script() }, signal: ctx.signal })
        expect(sealed.pixel).toBe(ARTIFACT_RGB)
        expect(sealed.inside?.ran).toBe(0)
        expect(sealed.inside?.title).toBe('ARTIFACT')
        expect(sealed.inside?.marker).toBe('ARTIFACT_RENDERED')

        // The oracle's presence precondition: grant the frame `allow-scripts` and drop the policy,
        // and this very fixture runs. Without this arm, "did not run" is also what an artifact with
        // no script in it reports.
        const loose = await open(browser(), {
          signal: ctx.signal,
          extra: { body: script() },
          csp: null,
          sandbox: 'allow-scripts allow-top-navigation-by-user-activation',
          // The oracle here is what the script did, and the marker element exists before it runs,
          // so this arm waits for the script's own write instead.
          frameReady: 'script'
        })
        expect(loose.pixel).toBe(ARTIFACT_RGB)
        expect(loose.inside?.ran).toBe(1)
        expect(loose.inside?.title).toBe('SCRIPT_RAN')
        // Nothing refused it, which is what "no policy" looks like from inside the frame.
        expect(loose.inside?.violations).toEqual([])

        // The second fence, measured on its own: grant `allow-scripts` and keep the shipped policy,
        // and the script still does not run, because a `srcdoc` frame inherits its embedder's
        // `script-src 'self'` and the artifact's script is inline. So the seal does not rest on the
        // sandbox attribute alone -- which is what makes the token list below a defence in depth
        // rather than the only thing standing between the page and an agent's script.
        const inherited = await open(browser(), {
          signal: ctx.signal,
          extra: { body: script() },
          sandbox: 'allow-scripts allow-top-navigation-by-user-activation'
        })
        expect(inherited.pixel).toBe(ARTIFACT_RGB)
        expect(inherited.inside?.ran).toBe(0)
        expect(inherited.inside?.title).toBe('ARTIFACT')
        // This arm's own precondition, and the thing CI showed a rig can get wrong: a frame that was
        // never really widened refuses the script too, silently and with no event, and would pass
        // every line above under a name that says the policy held. A violation raised inside the
        // frame can only happen if the sandbox let the script start, so this is the reading that
        // separates the two -- and it is the frame's own list, since the embedder's never sees it.
        expect(String(inherited.inside?.violations)).toContain('script-src')
        // The sealed arm is the contrast: no policy refused anything there, the sandbox simply never
        // let the script begin.
        expect(sealed.inside?.violations).toEqual([])
      }, 180_000)

      it('fetches nothing of the artifact that leaves the origin, and would if allowed', async (ctx) => {
        const sealed = await open(browser(), { signal: ctx.signal })
        expect(sealed.pixel).toBe(ARTIFACT_RGB)
        expect(sealed.foreignHits).toEqual([])
        // The control: with no policy the same three subresources are fetched, so the empty list
        // above is the inherited `img-src` and `font-src` and not an artifact that never parsed.
        const control = await open(browser(), { csp: null, signal: ctx.signal })
        expect(control.pixel).toBe(ARTIFACT_RGB)
        expect(control.foreignHits).toEqual(
          expect.arrayContaining(['/img.png', '/css-bg.png', '/probe.woff2'])
        )
      }, 120_000)

      it('asks to navigate the top frame to the shell itself, which the shell must refuse', async (ctx) => {
        // `href="/"` resolves against the embedder's base, so this is a request to load the shell's
        // own document -- one tap that would clear the bridge target, restart the load state and
        // lose the page. The browser hands it up like any other, so refusing it is the shell's job
        // and the native tests named above are where that is pinned; what this counts is that the
        // request is real and reaches the shell at all.
        const root = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#rootlink', { timeout: 2000 }).catch(() => {})
          }
        })
        expect(root.pixelBefore).toBe(ARTIFACT_RGB)
        expect(root.ownOriginTopNavigations).toBe(1)
        expect(root.topNavigations).toBe(0)

        // `href=""` is the same navigation spelled as "this document", and it resolves the same way.
        const empty = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#emptylink', { timeout: 2000 }).catch(() => {})
          }
        })
        expect(empty.pixelBefore).toBe(ARTIFACT_RGB)
        expect(empty.ownOriginTopNavigations).toBe(1)
        expect(empty.topNavigations).toBe(0)
      }, 180_000)

      it("hands a user's tap on a link to the top frame, exactly once", async (ctx) => {
        const read = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#toplink', { timeout: 2000 }).catch(() => {})
          }
        })
        expect(read.pixelBefore).toBe(ARTIFACT_RGB)
        expect(read.topNavigations).toBe(1)
        expect(read.ownOriginTopNavigations).toBe(0)
        expect(read.popups).toBe(0)
      }, 120_000)

      it("cannot reach the shell through a meta refresh at the embedder's own URL", async (ctx) => {
        // `content="0;url=/"` resolves against the embedder's base, so this is the artifact asking
        // for the shell's own document with no tap behind it. The foreign meta-refresh arm below
        // cannot say anything about that: its URL is off-origin, so its own-origin count is zero
        // whatever the frame did.
        const own = await open(browser(), {
          signal: ctx.signal,
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' }
        })
        // The frame is still showing the artifact, so what follows is about a refusal rather than
        // about a frame that never rendered.
        expect(own.pixelBefore).toBe(ARTIFACT_RGB)
        // Zero against a counter that is not blind: the `href="/"` case above reads exactly 1 on this
        // same reading, from this same rig.
        expect(own.ownOriginTopNavigations).toBe(0)
        expect(own.topNavigations).toBe(0)
        // The other escape the same fixture could take: the frame fetching the shell's document for
        // itself, which would put the session's own page inside the preview.
        expect(own.ownOriginFrameNavigations).toBe(0)

        // That zero's presence precondition: give the frame `allow-same-origin` and drop the policy
        // and this very fixture navigates the frame to the embedder's `/`, so the reading is not
        // blind.
        const loose = await open(browser(), {
          signal: ctx.signal,
          csp: null,
          sandbox: 'allow-scripts allow-same-origin allow-top-navigation',
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' },
          // This arm's frame leaves the artifact behind, which is the whole point of it, so the
          // marker is not what says it is ready, and the navigation it makes is what it waits for.
          frameReady: 'load',
          expectNavigation: 'frame'
        })
        expect(loose.ownOriginFrameNavigations).toBe(1)

        // Two fences, either of which would hold, each run with the other taken away -- the shape
        // the script case above uses, rather than a claim in a comment.
        //
        // The token alone: no policy at all, and the navigation never starts, so nothing is served
        // and nothing is reported.
        const tokenOnly = await open(browser(), {
          signal: ctx.signal,
          csp: null,
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' }
        })
        expect(tokenOnly.pixelBefore).toBe(ARTIFACT_RGB)
        expect(tokenOnly.ownOriginFrameNavigations).toBe(0)
        expect(tokenOnly.ownOriginTopNavigations).toBe(0)
        expect(tokenOnly.violations).toEqual([])

        // The policy alone: grant `allow-same-origin`, keep the shipped header, and the navigation
        // does start -- and `frame-src 'none'` refuses it, which the embedder reports as its own
        // violation because a parent's policy governs where its frame may go. The engines differ
        // only in what is left behind: chromium swaps an error page into the frame, WebKit leaves
        // the artifact showing. Neither is asserted; the request never reaching the server is.
        const policyOnly = await open(browser(), {
          signal: ctx.signal,
          sandbox: 'allow-scripts allow-same-origin allow-top-navigation',
          extra: { head: '<meta http-equiv="refresh" content="0;url=/">' },
          frameReady: 'load'
        })
        expect(policyOnly.ownOriginFrameNavigations).toBe(0)
        expect(policyOnly.ownOriginTopNavigations).toBe(0)
        expect(policyOnly.violations.join(' ')).toContain('frame-src')
      }, 180_000)

      it('hands up nothing without a tap, and nothing for a form or a new window', async (ctx) => {
        const meta = await open(browser(), {
          signal: ctx.signal,
          extra: { head: `<meta http-equiv="refresh" content="0;url=${foreignOrigin}/meta.html">` }
        })
        expect(meta.topNavigations).toBe(0)
        expect(meta.ownOriginTopNavigations).toBe(0)
        const form = await open(browser(), {
          signal: ctx.signal,
          act: async ({ frame }) => {
            await frame?.click('#submit', { timeout: 2000 }).catch(() => {})
          }
        })
        expect(form.pixelBefore).toBe(ARTIFACT_RGB)
        expect(form.topNavigations).toBe(0)
        const blank = await open(browser(), {
          signal: ctx.signal,
          act: async ({ frame }) => {
            await frame?.click('#blanklink', { timeout: 2000 }).catch(() => {})
          }
        })
        expect(blank.pixelBefore).toBe(ARTIFACT_RGB)
        expect(blank.topNavigations).toBe(0)
        expect(blank.popups).toBe(0)
      }, 180_000)

      it('keeps the Preview/Source toggle, and Source shows the source', async (ctx) => {
        const read = await open(browser(), {
          signal: ctx.signal,
          act: async ({ page }) => {
            await page.getByLabel('View HTML source').click({ timeout: 2000 })
          }
        })
        // Both positions announce which one is showing, before and after the tap. Asserted on the
        // DOM because that is where a screen reader reads it.
        expect(read.togglesBefore).toEqual([
          { label: 'Preview rendered HTML', selected: 'true' },
          { label: 'View HTML source', selected: 'false' }
        ])
        expect(read.toggles).toEqual([
          { label: 'Preview rendered HTML', selected: 'false' },
          { label: 'View HTML source', selected: 'true' }
        ])
        expect(read.body).toContain('SOURCE_TAB_RENDERED')
        // The frame went with the preview, which is why the toggle is not a control that lies.
        expect(read.frameCount).toBe(0)
        expect(read.pixel).toBe(PAGE_RGB)
      }, 120_000)
    },
    600_000
  )
}

/** The artifact's inline script, with the foreign origin the fixture is built against. */
function script() {
  return ARTIFACT_SCRIPT.replaceAll('${foreignOrigin}', foreignOrigin)
}

describe('the HTML preview needs no policy change', () => {
  it('runs under a policy that still forbids every nested frame by URL', async () => {
    const directives = (await readShellCsp()).split('; ')
    // A `srcdoc` frame has no URL for `frame-src` to match, so the sealed box costs nothing here.
    // Pinned so a future relaxation is a decision rather than a side effect of this component.
    expect(directives).toContain("frame-src 'none'")
    expect(directives).toContain("child-src 'none'")
    expect(directives).toContain("script-src 'self'")
    expect(directives).toContain("frame-ancestors 'none'")
  })

  it('grants exactly one sandbox token, and neither of the two that would unseal the frame', async () => {
    const source = await readFileText('mobile/src/components/MobileHtmlPreview.web.tsx')
    const match = /MOBILE_HTML_PREVIEW_SANDBOX = '([^']*)'/.exec(source)
    expect(match).not.toBeNull()
    const tokens = (match?.[1] ?? '').split(' ').filter((one) => one.length > 0)
    expect(tokens).toEqual(['allow-top-navigation-by-user-activation'])
    // Named rather than left to the list comparison: these two are the sealing invariant, and a
    // reader of a failure should see which one was granted.
    expect(tokens).not.toContain('allow-scripts')
    expect(tokens).not.toContain('allow-same-origin')
  })
})

/**
 * The mounted frame, once it holds the artifact.
 *
 * Found by its element, never by its URL. A `srcdoc` frame reports `about:srcdoc` on both engines
 * here and an empty URL on CI's browser, and a poll that waited for the string spent every case's
 * whole timeout there -- seven timeouts on one engine, after the same difference had already shown
 * up as `expected '' to be 'about:srcdoc'`.
 *
 * Three things still settle at their own moments: React commits the mount, the element's `srcdoc`
 * commits a document, and an override arm replaces that document with a second one. So readiness is
 * the fixture's own marker inside the frame, which exists only once the artifact has parsed there.
 *
 * `frameReady` is which of those an arm is waiting for, because the marker is not always the right
 * one. `'script'` waits for what the inline script writes: the marker element exists from parse
 * time, so an arm whose oracle is "the script ran" would otherwise read `window.__ran` before it
 * had. `'load'` is for the one arm whose artifact deliberately navigates the frame somewhere else,
 * where no marker is ever coming.
 */
async function waitForLoadedFrame(page, frameReady = 'artifact', signal, browserVersion, arm) {
  const element = await page.waitForSelector('iframe', { timeout: 0 })
  const frame = await element.contentFrame()
  if (!frame) {
    return null
  }
  await frame.waitForLoadState('load').catch(() => {})
  if (frameReady === 'script') {
    await untilAborted(
      frame.waitForFunction(() => window.__ran === 1, undefined, { timeout: 0 }),
      signal,
      async () =>
        `the artifact's script never ran inside the frame: ${arm} | ${await describePreviewFrame(page, frame, browserVersion)}`
    )
  }
  if (frameReady !== 'load') {
    await untilAborted(
      frame.waitForSelector('#marker', { state: 'attached', timeout: 0 }),
      signal,
      async () =>
        `the artifact never parsed inside the frame: ${arm} | ${await describePreviewFrame(page, frame, browserVersion)}`
    )
  }
  return frame
}

/**
 * Where an arm's counters are read: after the thing it is about, whatever that thing is.
 *
 * `expectNavigation` names what the arm is waiting for, and an arm that expects one waits for the
 * record itself rather than for a clock. An arm that expects none has nothing to await, so it takes
 * the bounded path below.
 */
async function settleAfterMount(page, navigations, expectNavigation, signal, reading) {
  if (expectNavigation === 'main-frame') {
    return await waitForRecordedNavigation(page, navigations, (one) => one.main, signal, reading)
  }
  if (expectNavigation === 'frame') {
    return await waitForRecordedNavigation(
      page,
      navigations,
      (one) => !one.main && !one.foreign,
      signal,
      reading
    )
  }
  return await settleWithoutNavigation(page)
}

/**
 * The moment the arm's navigation exists, for an arm that expects one.
 *
 * No clock at all: the route handler above records a main-frame navigation as the browser dispatches
 * it, so the oracles are read after the thing under test rather than after a wait, and the only
 * bound is the case's own timeout through `ctx.signal`. An arm whose click missed its target prints
 * what it did record and lets the case fail as the timeout it is.
 *
 * Measured, so it is not sold as more than it is: with this replaced by a no-op every arm still
 * passes, because the reads that follow are each a round trip and the record lands during them. It is
 * the load the CI runner was under that this is for, which is the same condition that produced the
 * frame-commit race above.
 */
async function waitForRecordedNavigation(page, navigations, matches, signal, reading) {
  // Sampled while waiting, for the same reason `untilAborted` samples: a reading taken at the abort
  // can lose its race with vitest's teardown and never reach the log.
  let latest = 'no reading was taken before the case ended'
  let since = Date.now()
  while (!navigations.some((one) => matches(one))) {
    if (signal?.aborted) {
      console.error(
        `[html-preview-render] the arm produced no navigation of the kind it expects; recorded ${JSON.stringify(navigations)}: ${reading?.arm ?? 'arm unknown'} | ${latest}`
      )
      return
    }
    if (Date.now() - since > 5000) {
      since = Date.now()
      latest = await describePreviewFrame(page, reading?.frame, reading?.browserVersion).catch(
        (error) => `the reading itself failed: ${String(error).split('\n')[0]}`
      )
    }
    await page.waitForTimeout(10)
  }
}

/**
 * Where an absence is read, for the arms that expect no navigation at all.
 *
 * Nothing signals "the tap produced nothing", so this one is bounded rather than awaited. Two painted
 * frames inside the page come first: by the second, a navigation the click started has been dispatched
 * and would already be in the list the arms above read. The 200 ms after it is for the popup queue,
 * which is a browser-process event with no in-page counterpart to await.
 *
 * What keeps these absences honest is not the length of that wait: the arms that read 1 on the same
 * counters take the path above, so a counter that had stopped counting reds there.
 */
async function settleWithoutNavigation(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.waitForTimeout(200)
}

/** One pixel of the frame's own fill, which is what says the artifact parsed and painted. */
async function probePixel(page) {
  const png = PNG.sync.read(await page.screenshot({ clip: FRAME_PROBE }))
  return `${png.data[0]},${png.data[1]},${png.data[2]}`
}

async function readFileText(relativePath) {
  const { readFile } = await import('node:fs/promises')
  return await readFile(join(mobileDir, '..', relativePath), 'utf8')
}
