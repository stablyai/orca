/**
 * One arm of the HTML-preview render rig: mount an artifact, act on it, and read what happened.
 */
import { recordRequestsTo } from './mobile-web-app-preview-request-log.mjs'
import { watchImageEvidence } from './mobile-web-app-preview-image-evidence.mjs'
import { artifact } from './mobile-web-app-preview-artifact-fixture.mjs'
import {
  previewFrame,
  settleAfterMount,
  waitForLoadedFrame
} from './mobile-web-app-preview-frame-readiness.mjs'
import {
  probePreviewPixel,
  readPreviewArm,
  readPreviewToggles
} from './mobile-web-app-preview-frame-readings.mjs'

/**
 * Mounts the preview with one artifact and reports everything a case can assert on.
 *
 * `csp: null` is the control arm. The foreign origin's hit list is reset per open, so what it holds
 * is this artifact's doing.
 *
 * Its own module, and the boundary `mobile-web-app-preview-frame-readings.mjs` already names: the
 * rig file holds what each case claims, this holds how an arm is driven, and that one holds what a
 * driven arm reports. The three grow for different reasons and were over the 600-line cap together.
 *
 * `rig` is everything the driver cannot build for itself -- the servers and origins the suite
 * started once, the sink refusals are attributed through, the pixel clip, and the nonce counter it
 * advances. Passed rather than imported, because a module-level copy of that state is a second one.
 */
export async function openPreviewArm(
  rig,
  browser,
  {
    extra = {},
    csp = 'shipped',
    sandbox,
    act,
    expectNavigation = null,
    frameReady = 'artifact',
    assets,
    doctype,
    reportReady = null,
    /** What the shell told this page it may do. Defaults to the session route's own list, so an arm
     *  that does not mention it measures the shipped screen (C8.1). */
    grants = null,
    signal
  } = {}
) {
  const { origins, foreignOrigin, foreignHits, assetServer, cspReports, clip } = rig
  const origin = origins[csp === 'shipped' ? 'shipped' : csp === 'leaky' ? 'leaky' : 'none']
  rig.nonce += 1
  const nonce = `n${String(rig.nonce)}`
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
      ([html, override, granted]) => window.__mount(html, override, granted),
      [
        artifact({
          links: foreignOrigin,
          assets: assets ?? foreignOrigin,
          extra,
          nonce,
          ...(doctype === undefined ? {} : { doctype })
        }),
        sandbox ?? null,
        grants
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
    const pixelBefore = await probePreviewPixel(page, clip)
    // Sampled before the action as well, because the toggle's whole claim is that it changes.
    const togglesBefore = await readPreviewToggles(page)
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
    const result = await readPreviewArm({
      page,
      clip,
      pixelBefore,
      togglesBefore,
      servedCsp,
      actError,
      navigations,
      popups,
      foreignHits,
      readImageHits,
      assetServer,
      cspReports,
      nonce
    })
    return result
  } finally {
    // The context and not just the page: an arm whose wait aborted still owns one, and the case
    // after it runs on the same browser. On the happy path this is the close that always ran.
    await page.close().catch(() => {})
    await context.close().catch(() => {})
  }
}
