/**
 * Everything one arm of the HTML-preview render rig can be asserted on, read off a settled page.
 *
 * Split from the rig for the reason `mobile-web-app-preview-frame-readiness.mjs` and
 * `mobile-web-app-preview-csp-reports.mjs` were: the rig file holds how an arm is driven and what
 * each case claims, and this holds what a driven arm reports. They grow for different reasons -- a
 * case is added when a fence is added, a reading when a fence becomes measurable in a new way -- and
 * together they were over the 600-line cap the moment C8.1's link readings landed.
 *
 * Every reading is taken after the arm has settled, and every one that reaches inside the frame
 * falls back to null: the frame is an opaque origin, so an engine that refuses to evaluate in one
 * reports absence rather than failing the arm. A case that depends on such a reading therefore pins
 * a presence precondition beside it.
 */
import { PNG } from 'pngjs'
import { reportedDirectives } from './mobile-web-app-preview-csp-reports.mjs'
import { previewFrame } from './mobile-web-app-preview-frame-readiness.mjs'

/**
 * One RGB triple from the page, clipped to where the frame sits.
 *
 * A pixel rather than a read inside the frame, because the frame is an opaque origin and the paint
 * is the one claim that must hold on every engine.
 */
export async function probePreviewPixel(page, clip) {
  const png = PNG.sync.read(await page.screenshot({ clip }))
  return `${png.data[0]},${png.data[1]},${png.data[2]}`
}

/** What the toolbar emits into the DOM, not what the component was handed: react-native-web
 *  forwards `aria-*` and drops `accessibilityState` on the floor, so a selected state that reads
 *  fine in the test renderer can reach a screen reader as nothing at all. */
export async function readPreviewToggles(page) {
  return await page
    .evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((one) => ({
        label: one.getAttribute('aria-label'),
        selected: one.getAttribute('aria-selected')
      }))
    )
    .catch(() => null)
}

/** The element's own attributes and geometry, which is where "the artifact is parsed inside the
 *  frame rather than fetched into it" actually lives. Read from the element the component rendered
 *  and not from the constant it exports: a literal in the JSX would leave the constant correct and
 *  the frame unsealed, which is what the control run for this rig did before this reading existed. */
async function readFrameElement(page) {
  return await page
    .evaluate(() => {
      const frame = document.querySelector('iframe')
      if (!frame) {
        return { sandbox: null, srcDoc: null, src: null, box: null }
      }
      const box = frame.getBoundingClientRect()
      return {
        sandbox: frame.getAttribute('sandbox'),
        srcDoc: frame.getAttribute('srcdoc'),
        src: frame.getAttribute('src'),
        // Reported so a pixel that read the page instead of the frame names the layout rather than
        // looking like a frame that refused to load.
        box: { x: box.x, y: box.y, width: box.width, height: box.height }
      }
    })
    .catch(() => ({ sandbox: null, srcDoc: null, src: null, box: null }))
}

/** The frame's own document: what the artifact rendered, whether its script ran, and the refusals
 *  the frame itself was told about. `securitypolicyviolation` does not cross frames, so the page's
 *  init script installs the same collector in every one. */
async function readInsideFrame(page) {
  return await (previewFrame(page)
    ?.evaluate(() => ({
      marker: document.getElementById('marker')?.textContent ?? null,
      title: document.title,
      // The two the hidden-link path could change without touching a link (C8.1 round 2). The
      // rendering mode the engine resolved from the doctype it was handed, and the text a
      // preformatted block holds -- both read off the frame's own document, because the claim is
      // about what the engine parsed rather than about the string the page built.
      compatMode: document.compatMode,
      // The doctype the frame's own document reports, which is the reading that discriminates:
      // `compatMode` cannot, because a `srcdoc` document takes its mode from its embedder.
      doctypePublicId: document.doctype?.publicId ?? null,
      doctypeSystemId: document.doctype?.systemId ?? null,
      preText: document.getElementById('pre')?.textContent ?? null,
      fragmentHref: document.getElementById('fraglink')?.getAttribute('href') ?? null,
      // Where the frame is aimed and where it has scrolled to, which is how a tap on a fragment is
      // told apart from a same-document scroll: inside this frame the base URL is the embedder's,
      // so a fragment resolves off-document and activating it navigates rather than scrolls.
      baseUri: document.baseURI,
      scrollY: Math.round(window.scrollY),
      ran: document.documentElement.dataset.ran === '1' ? 1 : 0,
      threw: document.documentElement.dataset.threw ?? null,
      // The two moments the late-listener question turns on: when the page's init script ran in
      // this frame, and when the artifact's own script did.
      initAt: window.__initAt ?? null,
      artifactAt: document.documentElement.dataset.artifactAt ?? null,
      violations: window.__violations ?? null
    }))
    .catch(() => null) ?? Promise.resolve(null))
}

/**
 * Whether the artifact's links are links, as a browser resolves them (C8.1, ruling 37.2).
 *
 * Three readings rather than one, because the ruling names three: no underline, no pointer cursor,
 * no anchor a tap does nothing on. The first two are the UA stylesheet's `a:any-link` rules
 * resolving, which is a computed style and cannot be read off the markup; the third is the markup.
 * `#toplink` is the fixture's own link and the one every tapping arm taps.
 *
 * `focusable` is asked by focusing, not by reading `tabIndex`: measured on Chromium 152 and WebKit,
 * an `<a>` with no `href` still answers `tabIndex` 0, so that property says nothing about the tab
 * order. It is the last reading taken, because it is the one that changes the document.
 */
async function readFrameLinks(page) {
  return await (previewFrame(page)
    ?.evaluate(() => {
      const first = document.getElementById('toplink')
      const style = first === null ? null : getComputedStyle(first)
      const reading = {
        linked: document.querySelectorAll('a[href], area[href]').length,
        // Every anchor the fixture wrote, link or not: the text has to still be there, because
        // hiding an affordance is not deleting what the author wrote.
        anchors: document.querySelectorAll('a').length,
        text: first?.textContent ?? null,
        decoration: style?.textDecorationLine ?? null,
        cursor: style?.cursor ?? null,
        focusable: null
      }
      if (first !== null) {
        first.focus()
        reading.focusable = document.activeElement === first
      }
      return reading
    })
    .catch(() => null) ?? Promise.resolve(null))
}

/**
 * The whole reading for one arm.
 *
 * `arm` carries what the rig already knows and cannot read back off the page: the counters it
 * subscribed for, the policy the response actually carried, and the error an action reported.
 */
export async function readPreviewArm({
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
}) {
  const element = await readFrameElement(page)
  return {
    page,
    pixelBefore,
    pixel: await probePreviewPixel(page, clip),
    declaredSandbox: await page.evaluate(() => window.__sandbox),
    togglesBefore,
    toggles: await readPreviewToggles(page),
    mountedSandbox: element.sandbox,
    mountedSrcDoc: element.srcDoc,
    mountedSrc: element.src,
    frameBox: element.box,
    frameCount: page.frames().length - 1,
    // Reported, never asserted on: a `srcdoc` frame's URL reads `about:srcdoc` on one engine and
    // empty on CI's browser, so nothing may be decided by it.
    frameUrl: previewFrame(page)?.url() ?? null,
    // What the shell told the page, read back off the document so an arm cannot assert against a
    // grant list it only believes it passed.
    grants: await page.evaluate(() => window.__grants ?? null),
    links: await readFrameLinks(page),
    inside: await readInsideFrame(page),
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
    // What each admitted request carried, this arm's only, so an absence is this artifact's. Read
    // off the header the listener received rather than off a request object handed to a route: the
    // header on the wire is what the shell's `Referrer-Policy` is about.
    secureReferers: assetServer.referersFor(nonce),
    violations: await page.evaluate(() => window.__violations),
    body: await page.evaluate(() => document.body.innerText)
  }
}
