import { recordRequestsTo } from './mobile-web-app-preview-request-log.mjs'
import { watchImageEvidence } from './mobile-web-app-preview-image-evidence.mjs'
import { ARTIFACT_RGB, artifact } from './mobile-web-app-preview-artifact-fixture.mjs'
import { pollReportsUntil } from './mobile-web-app-preview-csp-reports.mjs'
import { describePreviewFrame, untilAborted } from './mobile-web-app-preview-frame-diagnosis.mjs'
import {
  previewFrame,
  settleAfterMount,
  waitForFrameInputRouting,
  waitForLoadedFrame
} from './mobile-web-app-preview-frame-readiness.mjs'
import {
  probePreviewPixel,
  readPreviewArm,
  readPreviewToggles,
  waitForPaintedPreview
} from './mobile-web-app-preview-frame-readings.mjs'

// csp:null is no-header control; reset foreign-origin hits per artifact.
// Pass suite-owned servers/origins/counters as rig; module-level duplicate state would diverge from browser readings.
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
    reportAfterAct = null,
    // Default to session manifest grants so omitted override measures shipped screen.
    grants = null,
    signal
  } = {}
) {
  const { origins, foreignOrigin, foreignHits, assetServer, cspReports, clip } = rig
  const origin = origins[csp === 'shipped' ? 'shipped' : csp === 'leaky' ? 'leaky' : 'none']
  rig.nonce += 1
  const nonce = `n${String(rig.nonce)}`
  // Capture browser version before teardown; querying on abort lost race and printed unknown in CI.
  const browserVersion = browser.version()
  // Own explicit context for abort cleanup; engines share browser, arms do not. Trust only run-generated TLS listener certificate.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true
  })
  const page = await context.newPage()
  // Subscribe before goto to include load requests; collect cheaply and print only on abort.
  const requestLog = await recordRequestsTo(page, assetServer.origin)
  // Run fresh-image diagnostic probe only on failure.
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
    // Record page request events across frames; Chrome sandbox target isolation attaches interception too late.
    // Arm after rig goto so initial shell navigation does not count as artifact request.
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
    // Route interception only refuses top-frame navigation like shell; aborting self-frame navigation would fabricate artifact retention.
    const record = (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        return void route.abort()
      }
      return void route.continue()
    }
    await page.route(`${foreignOrigin}/**`, record)
    // Embedder violations only: artifact listeners cannot run inside sealed frame.
    await page.addInitScript(() => {
      // Record collector installation time in each frame; it cannot observe events before attachment.
      window.__initAt = `${String(Math.round(performance.now()))} ${document.readyState}`
      window.__violations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__violations.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`)
      })
      // Pointer input the embedder kept for itself over the frame; see `waitForFrameInputRouting`.
      if (window === window.top) {
        window.__embedderFramePointer = 0
        document.addEventListener(
          'mousemove',
          (event) => {
            if (event.target instanceof HTMLIFrameElement) {
              window.__embedderFramePointer += 1
            }
          },
          true
        )
      }
    })
    // Nonce in embedder URL matches CSP report endpoint, attributing URL-less srcdoc violations to correct arm.
    await page.goto(`${origin}/preview?n=${nonce}`, { waitUntil: 'load' })
    recordingNavigations = true
    // Register refusal after initial goto; artifact / or empty href later targets shell document. Native dropped-navigation suites pin actual refusal.
    await page.route(`${origin}/**`, record)
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
    const arm =
      `arm csp=${csp} sandbox=${sandbox ?? 'product'} frameReady=${frameReady} ` +
      `reportReady=${reportReady ?? 'none'} nonce=${nonce}`
    // Wait and assert from same counter; two independent event lists prove nothing about each other.
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
    // Sample pixel before action: top navigation can blank iframe before after-action read, hiding whether there was artifact to tap.
    // A `'load'` arm's frame leaves the artifact on purpose, so only the others wait for its paint.
    const pixelBefore =
      frameReady === 'load'
        ? await probePreviewPixel(page, clip)
        : await waitForPaintedPreview(page, clip, ARTIFACT_RGB, signal)
    // Sample toggle before action too; otherwise unchanged toggle could appear valid.
    const togglesBefore = await readPreviewToggles(page)
    let actError = null
    if (act) {
      // Record click errors: missed target and successful tap causing no navigation otherwise look identical.
      if (!artifactFrame || artifactFrame.isDetached()) {
        throw new Error('The loaded preview frame is missing before its action')
      }
      await waitForFrameInputRouting(page, clip, signal, arm)
      await act({ page, frame: artifactFrame }).catch((error) => {
        actError = String(error).split('\n')[0]
      })
    }
    // Settle every arm: meta-refresh can start navigation without tap, so early zero is not refusal.
    await settleAfterMount(page, navigations, expectNavigation, signal, {
      frame: artifactFrame,
      browserVersion,
      arm,
      describeRequests,
      // Carry click failure into bounded navigation wait; no record can arrive after failed action.
      actError
    })
    if (reportAfterAct && !actError) {
      await untilAborted(
        pollReportsUntil(cspReports, nonce, reportAfterAct, signal),
        signal,
        async () =>
          `the policy reported no ${String(reportAfterAct)} refusal after the action: ${arm} | ${await describePreviewFrame(page, previewFrame(page), browserVersion)}`
      )
    }
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
    // Close arm’s context on failure too; following case shares same engine browser.
    await page.close().catch(() => {})
    await context.close().catch(() => {})
  }
}
