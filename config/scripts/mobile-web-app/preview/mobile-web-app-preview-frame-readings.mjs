// Read settled arm; opaque-frame evaluation failures return null, so dependent cases must require a matching positive reading.
import { PNG } from 'pngjs'
import { reportedDirectives } from './mobile-web-app-preview-csp-reports.mjs'
import { POLL_MS, abandonAfter, previewFrame } from './mobile-web-app-preview-frame-readiness.mjs'

// Pixel paint oracle works even when engine refuses opaque-frame DOM evaluation.
export async function probePreviewPixel(page, clip) {
  const png = PNG.sync.read(await page.screenshot({ clip }))
  return `${png.data[0]},${png.data[1]},${png.data[2]}`
}

/** Long enough for a loaded runner to composite a parsed frame; a frame that never paints still reds. */
const PAINT_MS = 10_000

/** Chromium composites sandbox-process surfaces after document completion; wait for the expected pixel. */
export async function waitForPaintedPreview(page, clip, expected, signal) {
  const started = Date.now()
  let pixel = await probePreviewPixel(page, clip)
  while (pixel !== expected && !signal?.aborted && Date.now() - started < PAINT_MS) {
    await abandonAfter(POLL_MS)
    pixel = await probePreviewPixel(page, clip)
  }
  return pixel
}

// Read emitted aria state: RN-Web forwards aria-* but drops accessibilityState that appears valid in test renderer.
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

// Read actual iframe attrs/geometry, not exported sandbox constant; JSX can diverge and leave constant correct while frame unsealed.
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
        // Include frame box to distinguish pixel clipped outside frame from actual refused paint.
        box: { x: box.x, y: box.y, width: box.width, height: box.height }
      }
    })
    .catch(() => ({ sandbox: null, srcDoc: null, src: null, box: null }))
}

// Read per-frame violations: securitypolicyviolation never bubbles across frames.
async function readInsideFrame(page) {
  return await (previewFrame(page)
    ?.evaluate(() => ({
      marker: document.getElementById('marker')?.textContent ?? null,
      title: document.title,
      // Read actual parsed mode/pre text to detect hidden-link round-trip losses beyond links.
      compatMode: document.compatMode,
      // Doctype IDs discriminate preservation; srcdoc compatMode inherits embedder mode.
      doctypePublicId: document.doctype?.publicId ?? null,
      doctypeSystemId: document.doctype?.systemId ?? null,
      preText: document.getElementById('pre')?.textContent ?? null,
      fragmentHref: document.getElementById('fraglink')?.getAttribute('href') ?? null,
      // Read URL/base/scroll to distinguish off-document srcdoc fragment navigation from real scroll.
      baseUri: document.baseURI,
      scrollY: Math.round(window.scrollY),
      ran: document.documentElement.dataset.ran === '1' ? 1 : 0,
      threw: document.documentElement.dataset.threw ?? null,
      // Record collector and artifact execution times to identify late listener.
      initAt: window.__initAt ?? null,
      artifactAt: document.documentElement.dataset.artifactAt ?? null,
      violations: window.__violations ?? null
    }))
    .catch(() => null) ?? Promise.resolve(null))
}

// Read actual anchor/style affordances; fixture toplink is tap target.
// Probe focus last (it mutates document): no-href anchor still reports tabIndex 0 in both engines, so property alone cannot prove focusability.
async function readFrameLinks(page) {
  return await (previewFrame(page)
    ?.evaluate(() => {
      const first = document.getElementById('toplink')
      const style = first === null ? null : getComputedStyle(first)
      const reading = {
        linked: document.querySelectorAll('a[href], area[href]').length,
        // Retain text/elements when removing link affordance; do not delete author content.
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

// Pass arm-owned counters, served policy and action errors; page cannot reconstruct them.
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
    // A top-frame navigation can discard the capture surface; its paint precondition is pixelBefore.
    pixel: navigations.some((one) => one.main) ? null : await probePreviewPixel(page, clip),
    declaredSandbox: await page.evaluate(() => window.__sandbox),
    togglesBefore,
    toggles: await readPreviewToggles(page),
    mountedSandbox: element.sandbox,
    mountedSrcDoc: element.srcDoc,
    mountedSrc: element.src,
    frameBox: element.box,
    frameCount: page.frames().length - 1,
    // Report URL diagnostically only: srcdoc can be about:srcdoc or empty depending on engine.
    frameUrl: previewFrame(page)?.url() ?? null,
    // Read negotiated grants from document, not list caller merely intended to pass.
    grants: await page.evaluate(() => window.__grants ?? null),
    links: await readFrameLinks(page),
    inside: await readInsideFrame(page),
    // Read served policy to assert shipped directives plus reporting endpoint exactly.
    servedCsp,
    // Use browser reports for refusals frame listener may miss.
    reported: reportedDirectives(cspReports, nonce),
    actError,
    topNavigations: navigations.filter((one) => one.main && one.foreign).length,
    ownOriginTopNavigations: navigations.filter((one) => one.main && !one.foreign).length,
    // Self-frame shell-origin fetch differs from top navigation and is blocked by different policy fence.
    ownOriginFrameNavigations: navigations.filter((one) => !one.main && !one.foreign).length,
    popups: popups.length,
    // Filter foreign hits by arm nonce, then strip bookkeeping query for assertions.
    foreignHits: foreignHits
      .filter((one) => one.includes(`n=${nonce}`))
      .map((one) => one.split('?')[0]),
    secureHits: readImageHits(),
    // Read arm-filtered wire Referer at server, not intercepted request object, to prove shell header’s effect.
    secureReferers: assetServer.referersFor(nonce),
    violations: await page.evaluate(() => window.__violations),
    body: await page.evaluate(() => document.body.innerText)
  }
}
