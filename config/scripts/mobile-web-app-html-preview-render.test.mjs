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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as esbuild from 'esbuild'
import { PNG } from 'pngjs'
import { chromium, webkit } from 'playwright-core'
import { lucideBarrelPlugin } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  readShellCsp,
  readShellDocumentHeaders
} from './mobile-web-app-render-harness.mjs'
import { createCspReportSink, reportedDirectives } from './mobile-web-app-preview-csp-reports.mjs'
import { recordRequestsTo } from './mobile-web-app-preview-request-log.mjs'
import { startArtifactAssetServer } from './mobile-web-app-preview-asset-server.mjs'
import { watchImageEvidence } from './mobile-web-app-preview-image-evidence.mjs'
import {
  ARTIFACT_RGB,
  ENTRY_SOURCE,
  artifact,
  artifactScript
} from './mobile-web-app-preview-artifact-fixture.mjs'
import {
  previewFrame,
  settleAfterMount,
  waitForLoadedFrame,
  waitForRecordedNavigation
} from './mobile-web-app-preview-frame-readiness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

/** Where the preview sits once mounted, which is what the pixel oracle samples. */
const FRAME_PROBE = { x: 60, y: 200, width: 4, height: 4 }

/** The page behind the frame, so a frame that painted nothing reads as this instead. */
const PAGE_RGB = '17,17,17'

/** Where the artifact's links and subresources point, and the origin that counts what it asked for. */
let foreignOrigin = null
const foreignHits = []
let foreign = null

/**
 * The artifact's https asset origin: a real TLS listener rather than route interception.
 *
 * Interception could not measure it. Chrome 152 isolates the sandboxed `srcdoc` frame into its own
 * target, and the parser-inserted `<img>` is the document's first fetch, issued before interception
 * attaches there: the request escaped to the network, the unresolvable host failed it, and the rig
 * recorded nothing while the frame's own resource timing showed the fetch. A listener already
 * accepting before the page exists cannot be raced that way -- the request arrives or it does not,
 * and either answer is the measurement. `img-src https:` matches on scheme, so `https://127.0.0.1`
 * exercises the same directive any other https host would.
 */
let assetServer = null

let nonceCounter = 0

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
/**
 * A third server, serving the shipped policy with a deliberately permissive `Referrer-Policy`.
 * It is the presence precondition for the referrer reading: Chromium sends no referrer from a
 * srcdoc frame's image whatever the header says, so without an arm that does send one, "no
 * `Referer`" there would pass on a rig that dropped the header entirely.
 */
let leakyServer = null
const origins = {}
let shippedDocumentHeaders = null
/** Every refusal the sealed server's policy was told about, by the arm that caused it. */
const cspReports = createCspReportSink()

beforeAll(async () => {
  shippedCsp = await readShellCsp()
  shippedDocumentHeaders = await readShellDocumentHeaders()
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
  // Before any page exists, which is the point of it being a listener.
  assetServer = await startArtifactAssetServer(scratch)
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
  const sealed = await createBundleServer({
    outDir,
    // Per document, because each arm's policy names an endpoint carrying that arm's nonce.
    cspHeader: (request) => cspReports.policyFor(shippedCsp, request),
    documentHeaders: shippedDocumentHeaders,
    handleRequest: (request, response, path) => cspReports.handleRequest(request, response, path)
  })
  sealedServer = sealed.server
  origins.shipped = sealed.origin
  const bare = await createBundleServer({ outDir, cspHeader: null })
  openServer = bare.server
  origins.none = bare.origin
  const leaky = await createBundleServer({
    outDir,
    cspHeader: shippedCsp,
    documentHeaders: { 'Referrer-Policy': 'unsafe-url' }
  })
  leakyServer = leaky.server
  origins.leaky = leaky.origin
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
  leakyServer?.close()
  foreign?.close()
  assetServer?.server.close()
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
    assets,
    reportReady = null,
    signal
  } = {}
) {
  const origin = origins[csp === 'shipped' ? 'shipped' : csp === 'leaky' ? 'leaky' : 'none']
  nonceCounter += 1
  const nonce = `n${String(nonceCounter)}`
  // Read here and carried as a string: asked for at the abort it lost its race with teardown and
  // printed "browser unknown" in the CI log this diagnostic exists for.
  const browserVersion = browser.version()
  // An explicit context, so an arm that aborts mid-read can hand back everything it holds. The
  // arms share one browser per engine; only the context is theirs.
  // The asset listener's certificate is generated per run and trusted by nothing, which is what
  // this flag is for; the page's own origin is still plain http from the bundle server.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true
  })
  const page = await context.newPage()
  // Subscribed before the first navigation, so a request made during load is in the log. Cheap
  // while an arm passes: it fills arrays, and only an abort asks them to speak.
  const requestLog = await recordRequestsTo(page, assetServer.origin)
  // Asked only when an arm has aborted, so the fresh-image probe and its wait cost a failing run
  // and never a passing one.
  const describeRequests = watchImageEvidence(page, assetServer.origin, requestLog, assetServer.saw)
  try {
    const navigations = []
    const popups = []
    let servedCsp = null
    page.on('response', (response) => {
      if (response.url().startsWith(`${origin}/preview`)) {
        servedCsp = response.headers()['content-security-policy'] ?? null
      }
    })
    page.on('popup', (popup) => {
      popups.push(popup.url())
      void popup.close().catch(() => {})
    })
    // The record is the page's own event, not the route handler's. Interception is per target and
    // attaches late on a Chrome that isolates the sandboxed frame, which is what left the CI log
    // saying `recorded []`; `page.on('request')` is one subscription over every frame the page has.
    // Armed after the rig's own `goto`, exactly where the route used to be registered: the initial
    // navigation is a main-frame navigation to this origin and would otherwise count as one the
    // artifact asked for.
    let recordingNavigations = false
    page.on('request', (request) => {
      if (!recordingNavigations || !request.isNavigationRequest()) {
        return
      }
      const url = request.url()
      if (!url.startsWith(foreignOrigin) && !url.startsWith(origin)) {
        return
      }
      navigations.push({
        url,
        foreign: url.startsWith(foreignOrigin),
        main: request.frame() === page.mainFrame()
      })
    })
    // The route stays for what only a route can do: refuse the navigation. Playwright is not the
    // shell, so a top-frame navigation is aborted here the way the shell's delegate would refuse
    // it, and a frame navigating itself is left alone -- aborting that would make "the frame stayed
    // on the artifact" true by the rig's own doing.
    const record = (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        return void route.abort()
      }
      return void route.continue()
    }
    await page.route(`${foreignOrigin}/**`, record)
    // The shell page's violations, and only those: an artifact's own listener would have to run, and
    // the fence under test is that nothing in the artifact runs.
    await page.addInitScript(() => {
      // When this ran, in every frame it ran in. The collector below can only report what it was
      // present for, so its own moment is a reading rather than an assumption.
      window.__initAt = `${String(Math.round(performance.now()))} ${document.readyState}`
      window.__violations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__violations.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`)
      })
    })
    // The nonce in the document's own URL: the policy this response carries names a report endpoint
    // with the same nonce, which is how a report from a `srcdoc` frame with no URL of its own is
    // attributed to the arm that caused it.
    await page.goto(`${origin}/preview?n=${nonce}`, { waitUntil: 'load' })
    recordingNavigations = true
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
      [
        artifact({ links: foreignOrigin, assets: assets ?? foreignOrigin, extra, nonce }),
        sandbox ?? null
      ]
    )
    // Named in every diagnostic, because the log shows the case and not which of its arms spoke.
    const arm =
      `arm csp=${csp} sandbox=${sandbox ?? 'product'} frameReady=${frameReady} ` +
      `reportReady=${reportReady ?? 'none'} nonce=${nonce}`
    // One reader for the wait and for the reading: an arm that waits on one list and asserts on
    // another proves nothing about the list it asserts on.
    const readImageHits = () => assetServer.hitsFor(nonce)
    const artifactFrame = await waitForLoadedFrame(page, {
      frameReady,
      reportReady,
      signal,
      browserVersion,
      arm,
      sink: cspReports,
      nonce,
      readImageHits,
      describeRequests
    })
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
    let actError = null
    if (act) {
      // Recorded, never swallowed: a click that never landed and a click that produced no
      // navigation are the same empty counter, and only one of them is the product's doing.
      await act({ page, frame: previewFrame(page) }).catch((error) => {
        actError = String(error).split('\n')[0]
      })
    }
    // Every arm settles, acting or not: an artifact can start a navigation with no tap behind it --
    // `<meta http-equiv="refresh">` is one -- and the arms that pin zero were reading their counters
    // while that was still in flight.
    await settleAfterMount(page, navigations, expectNavigation, signal, {
      frame: artifactFrame,
      browserVersion,
      arm,
      describeRequests
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
      frameCount: page.frames().length - 1,
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
      frameUrl: previewFrame(page)?.url() ?? null,
      // The element's own attributes, which is where "the artifact is parsed inside the frame rather
      // than fetched into it" actually lives.
      mountedSrcDoc: await page
        .evaluate(() => document.querySelector('iframe')?.getAttribute('srcdoc') ?? null)
        .catch(() => null),
      mountedSrc: await page
        .evaluate(() => document.querySelector('iframe')?.getAttribute('src') ?? null)
        .catch(() => null),
      inside: await (previewFrame(page)
        ?.evaluate(() => ({
          marker: document.getElementById('marker')?.textContent ?? null,
          title: document.title,
          ran: document.documentElement.dataset.ran === '1' ? 1 : 0,
          threw: document.documentElement.dataset.threw ?? null,
          // The two moments the late-listener question turns on: when the page's init script ran in
          // this frame, and when the artifact's own script did.
          initAt: window.__initAt ?? null,
          artifactAt: document.documentElement.dataset.artifactAt ?? null,
          // The frame's own list, not the embedder's: `securitypolicyviolation` does not cross frames,
          // and the page's init script installs the same collector in every one.
          violations: window.__violations ?? null
        }))
        .catch(() => null) ?? Promise.resolve(null)),
      // What this document was actually served, so "the shipped policy, plus a report endpoint and
      // nothing else" is asserted rather than intended.
      servedCsp,
      // Every refusal the browser reported for this arm, which is the evidence an in-frame listener
      // cannot be relied on to have collected.
      reported: reportedDirectives(cspReports, nonce),
      // Null on every arm that acted successfully, and on every arm that did not act at all.
      actError,
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
      // Same shape as `foreignHits` and read the same way: this arm's requests only, by nonce, as
      // paths. Absolute URLs go in, so the origin is stripped along with the query.
      secureHits: readImageHits(),
      // What each admitted request carried, this arm's only, so an absence is this artifact's.
      // Read off the header the listener received rather than off a request object handed to a
      // route: the header on the wire is what the shell's `Referrer-Policy` is about.
      secureReferers: assetServer.referersFor(nonce),
      violations: await page.evaluate(() => window.__violations),
      body: await page.evaluate(() => document.body.innerText)
    }
    return result
  } finally {
    // The context and not just the page: an arm whose wait aborted still owns one, and the case
    // after it runs on the same browser. On the happy path this is the close that always ran.
    await page.close().catch(() => {})
    await context.close().catch(() => {})
  }
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
        // The policy this document was served is the shell's own text plus the rig's report
        // endpoint, and nothing else: `report-uri` says where a refusal is sent and changes nothing
        // about what is enforced, so the arms below measure the shipped policy.
        const servedParts = (read.servedCsp ?? '').split('; report-uri ')
        expect(servedParts[0]).toBe(shippedCsp)
        expect(servedParts).toHaveLength(2)
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
        const sealed = await open(browser(), {
          extra: { body: artifactScript(foreignOrigin) },
          signal: ctx.signal,
          // The refusal this arm does cause, waited for so the missing one below is an absence
          // measured beside a presence rather than a list read too early.
          reportReady: 'img-src'
        })
        expect(sealed.pixel).toBe(ARTIFACT_RGB)
        expect(sealed.inside?.ran).toBe(0)
        expect(sealed.inside?.title).toBe('ARTIFACT')
        expect(sealed.inside?.marker).toBe('ARTIFACT_RENDERED')

        // The oracle's presence precondition: grant the frame `allow-scripts` and drop the policy,
        // and this very fixture runs. Without this arm, "did not run" is also what an artifact with
        // no script in it reports.
        const loose = await open(browser(), {
          signal: ctx.signal,
          extra: { body: artifactScript(foreignOrigin) },
          csp: null,
          sandbox: 'allow-scripts allow-top-navigation-by-user-activation',
          // The oracle here is what the script did, and the marker element exists before it runs,
          // so this arm waits for the script's own write instead.
          frameReady: 'script'
        })
        expect(loose.pixel).toBe(ARTIFACT_RGB)
        expect(loose.inside?.ran).toBe(1)
        expect(loose.inside?.title).toBe('SCRIPT_RAN')
        // Nothing refused it, which is what "no policy" looks like: this arm's server sends no
        // header at all, so there is no policy to report against and the script ran.
        expect(loose.reported).toEqual([])

        // The second fence, measured on its own: grant `allow-scripts` and keep the shipped policy,
        // and the script still does not run, because a `srcdoc` frame inherits its embedder's
        // `script-src 'self'` and the artifact's script is inline. So the seal does not rest on the
        // sandbox attribute alone -- which is what makes the token list below a defence in depth
        // rather than the only thing standing between the page and an agent's script.
        const inherited = await open(browser(), {
          signal: ctx.signal,
          extra: { body: artifactScript(foreignOrigin) },
          sandbox: 'allow-scripts allow-top-navigation-by-user-activation',
          // The refusal below is this arm's oracle, so the arm waits for the browser to have
          // reported it rather than reading whatever a list inside the frame happens to hold.
          reportReady: 'script-src'
        })
        expect(inherited.pixel).toBe(ARTIFACT_RGB)
        expect(inherited.inside?.ran).toBe(0)
        expect(inherited.inside?.title).toBe('ARTIFACT')
        // This arm's own precondition, and the thing CI showed a rig can get wrong: a frame that was
        // never really widened refuses the script too, silently and with no report, and would pass
        // every line above under a name that says the policy held. A `script-src` refusal can only
        // be reported if the sandbox let the script start, so this is the reading that separates the
        // two -- and it comes from the browser rather than from a listener in the frame, which on
        // CI's Chrome intermittently missed this very entry while catching the image one beside it.
        expect(inherited.reported.join(' ')).toContain('script-src')
        // The sealed arm is the contrast, and it is why that line means what it says: the same
        // artifact under the same policy was reported only for its image. Nothing refused its
        // script, because the sandbox never let it begin.
        expect(sealed.reported.join(' ')).toContain('img-src')
        expect(sealed.reported.join(' ')).not.toContain('script-src')
      }, 180_000)

      it('refuses the artifact cleartext subresources by scheme and its font by directive', async (ctx) => {
        const sealed = await open(browser(), { signal: ctx.signal })
        expect(sealed.pixel).toBe(ARTIFACT_RGB)
        expect(sealed.foreignHits).toEqual([])
        // Two fences, not one, and the case name says which is which: this origin is cleartext
        // `http:`, so `img-src 'self' data: https:` refuses both images on the scheme alone, and
        // `font-src 'none'` refuses the font whatever its scheme. The https arm below is the other
        // half -- remove it and an empty list here reads as "no remote subresource ever loads",
        // which stopped being true when the directive gained `https:`.
        const control = await open(browser(), { csp: null, signal: ctx.signal })
        expect(control.pixel).toBe(ARTIFACT_RGB)
        expect(control.foreignHits).toEqual(
          expect.arrayContaining(['/img.png', '/css-bg.png', '/probe.woff2'])
        )
      }, 120_000)

      it('loads the artifact https images the directive admits, and still refuses its font', async (ctx) => {
        // Waited for, not hoped for: `frameReady: 'images'` is what makes the presence below a read
        // after the requests rather than after a clock. CI's Chrome 152 had recorded the background
        // and not the element when the old bounded settle expired.
        const read = await open(browser(), {
          assets: assetServer.origin,
          frameReady: 'images',
          signal: ctx.signal
        })
        expect(read.pixel).toBe(ARTIFACT_RGB)
        // Both images, because `img-src` governs a CSS background as well as an `<img>` element,
        // and a case that only watched the element would miss half of what the directive opened.
        expect([...read.secureHits].sort()).toEqual(['/css-bg.png', '/img.png'])
        // The directive that did not move, measured on the same origin in the same arm: `https:`
        // reached `img-src` and nothing else, so the font is refused where the images are not.
        expect(read.secureHits).not.toContain('/probe.woff2')
      }, 120_000)

      it('sends no referrer with an admitted https image, which is the shell header doing it', async (ctx) => {
        const sealed = await open(browser(), {
          assets: assetServer.origin,
          frameReady: 'images',
          signal: ctx.signal
        })
        // The presence precondition for the absence below: two requests were admitted and read, so
        // an empty referrer list is what they carried rather than a list of nothing.
        expect(sealed.secureHits.length).toBe(2)
        expect(sealed.secureReferers).toEqual([null, null])

        // Why the shell sends the header at all. Serve the same policy with a permissive
        // `Referrer-Policy` and WebKit puts the embedder's URL on the image request, despite
        // `referrerPolicy="no-referrer"` on the iframe element; on the phone that URL is
        // `orca-mobile-web://<sessionId>/`, so the session id would reach the image host. Chromium
        // sends none either way, which is worth pinning too: on that engine the reading above is
        // the browser's own behaviour and not evidence the header arrived.
        const leaky = await open(browser(), {
          assets: assetServer.origin,
          csp: 'leaky',
          frameReady: 'images',
          signal: ctx.signal
        })
        expect(leaky.secureHits.length).toBe(2)
        const leaked = leaky.secureReferers.filter((one) => one !== null)
        if (engine === 'webkit') {
          expect(leaked.length).toBe(2)
          expect(leaked.every((one) => one.startsWith(origins.leaky))).toBe(true)
        } else {
          expect(leaked).toEqual([])
        }
      }, 180_000)

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
            await frame?.click('#rootlink', { timeout: 2000 })
          }
        })
        expect(root.pixelBefore).toBe(ARTIFACT_RGB)
        // The tap landed. Without this the two counts below read the same whether the product
        // refused to navigate or the rig never managed to click.
        expect(root.actError).toBeNull()
        expect(root.ownOriginTopNavigations).toBe(1)
        expect(root.topNavigations).toBe(0)

        // `href=""` is the same navigation spelled as "this document", and it resolves the same way.
        const empty = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#emptylink', { timeout: 2000 })
          }
        })
        expect(empty.pixelBefore).toBe(ARTIFACT_RGB)
        expect(empty.actError).toBeNull()
        expect(empty.ownOriginTopNavigations).toBe(1)
        expect(empty.topNavigations).toBe(0)
      }, 180_000)

      it("hands a user's tap on a link to the top frame, exactly once", async (ctx) => {
        const read = await open(browser(), {
          signal: ctx.signal,
          expectNavigation: 'main-frame',
          act: async ({ frame }) => {
            await frame?.click('#toplink', { timeout: 2000 })
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
            await frame?.click('#submit', { timeout: 2000 })
          }
        })
        expect(form.pixelBefore).toBe(ARTIFACT_RGB)
        expect(form.topNavigations).toBe(0)
        const blank = await open(browser(), {
          signal: ctx.signal,
          act: async ({ frame }) => {
            await frame?.click('#blanklink', { timeout: 2000 })
          }
        })
        expect(blank.pixelBefore).toBe(ARTIFACT_RGB)
        expect(blank.topNavigations).toBe(0)
        expect(blank.popups).toBe(0)
      }, 180_000)

      // The navigation wait's sampling branch, driven once. It fires only when an arm is slow, so
      // nothing here had ever executed it: a name out of scope inside it throws where no lint runs
      // and no case looks. The printed reading is the proof that it ran and returned one.
      it('reads the frame while a navigation it expects has not arrived', async (ctx) => {
        void ctx
        const page = await browser().newPage()
        const printed = []
        const spy = vi.spyOn(console, 'error').mockImplementation((line) => {
          printed.push(String(line))
        })
        const stop = new AbortController()
        const timer = setTimeout(() => stop.abort(), 300)
        await waitForRecordedNavigation(
          page,
          [],
          () => false,
          stop.signal,
          { arm: 'arm sampling-probe', browserVersion: browser().version() },
          25
        )
        clearTimeout(timer)
        spy.mockRestore()
        await page.close()
        expect(printed).toHaveLength(1)
        expect(printed[0]).toContain('arm sampling-probe')
        // Not the placeholder: this string is only there if the sampling branch produced a reading.
        expect(printed[0]).toContain('frames [')
      }, 60_000)

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

/** One pixel of the frame's own fill, which is what says the artifact parsed and painted. */
async function probePixel(page) {
  const png = PNG.sync.read(await page.screenshot({ clip: FRAME_PROBE }))
  return `${png.data[0]},${png.data[1]},${png.data[2]}`
}

async function readFileText(relativePath) {
  const { readFile } = await import('node:fs/promises')
  return await readFile(join(mobileDir, '..', relativePath), 'utf8')
}
