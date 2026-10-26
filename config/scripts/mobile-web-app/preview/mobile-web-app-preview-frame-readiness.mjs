// Poll main-world evaluate: Playwright selectors/functions need injected/isolated world whose creation can fail silently on stale Chrome frame.
// Resolve frame every attempt so late document commit replaces stale context; diagnosis separately probes utility world.

import { describePreviewFrame, untilAborted } from './mobile-web-app-preview-frame-diagnosis.mjs'
import { pollReportsUntil } from './mobile-web-app-preview-csp-reports.mjs'

export const POLL_MS = 25
const EVALUATE_MS = 1000

export function previewFrame(page) {
  return page.frames().find((one) => one !== page.mainFrame()) ?? null
}

export const abandonAfter = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
  })

// Return on case abort: untilAborted already printed diagnosis; late rejection would be unhandled.
export async function pollFrameUntil(page, predicate, signal) {
  while (!signal?.aborted) {
    const frame = previewFrame(page)
    // Abandon unbounded evaluate when case ends so missing main context cannot outlive owning frame.
    const met = frame
      ? await Promise.race([
          frame.evaluate(predicate).catch(() => false),
          abandonAfter(EVALUATE_MS)
        ])
      : false
    if (met) {
      return
    }
    await abandonAfter(POLL_MS)
  }
}

// Find actual frame, not URL: srcdoc URL can be empty on CI, and URL polling once timed out despite parsed artifact.
// Await artifact marker after mount/srcdoc/override commits; script arm awaits its own write, load arm awaits navigation away.
// reportReady/images await actual browser report or server requests instead of racing a fixed settle.
export async function waitForLoadedFrame(
  page,
  {
    frameReady = 'artifact',
    reportReady = null,
    signal,
    browserVersion,
    arm,
    sink,
    nonce,
    readImageHits,
    describeRequests
  }
) {
  const reading = async (what) =>
    `${what}: ${arm} | ${await describePreviewFrame(page, previewFrame(page), browserVersion)}`
  await untilAborted(
    pollFrameUntil(page, () => true, signal),
    signal,
    async () => await reading('no frame ever answered inside the page')
  )
  const frame = previewFrame(page)
  if (!frame) {
    return null
  }
  // Bind load wait to case abort; independent waitForLoadState timeout can outlive teardown.
  await untilAborted(
    pollFrameUntil(page, () => document.readyState === 'complete', signal),
    signal,
    async () => await reading('the frame never finished loading')
  )
  if (frameReady === 'script') {
    await untilAborted(
      pollFrameUntil(page, () => document.documentElement.dataset.ran === '1', signal),
      signal,
      async () => await reading("the artifact's script never ran inside the frame")
    )
  }
  if (reportReady) {
    // Wait browser CSP report, not in-frame listener that may attach late or never execute in sealed frame.
    await untilAborted(
      pollReportsUntil(sink, nonce, reportReady, signal),
      signal,
      async () =>
        await reading(`the policy reported no ${String(reportReady)} refusal for this arm`)
    )
  }
  if (frameReady !== 'load') {
    await untilAborted(
      pollFrameUntil(page, () => document.getElementById('marker') !== null, signal),
      signal,
      async () => await reading('the artifact never parsed inside the frame')
    )
  }
  if (frameReady === 'images') {
    await untilAborted(
      pollHitsUntilAdmitted(readImageHits, signal),
      signal,
      async () => await reading(await describeAdmittedImages(page, readImageHits, describeRequests))
    )
  }
  return previewFrame(page)
}

/** How long a painted frame may go on handing its input to the embedder before the arm gives up. */
const INPUT_ROUTING_MS = 10_000

/** Chromium may paint before its out-of-process iframe hit-test region arrives, sending clicks to the embedder.
 * Alternate pointer positions until embedder iframe events stop; repeated identical moves may emit nothing.
 * In-process engines route correctly on the first move. */
export async function waitForFrameInputRouting(page, clip, signal, arm) {
  const started = Date.now()
  const embedderSaw = async () => await page.evaluate(() => window.__embedderFramePointer ?? 0)
  for (let step = 0; !signal?.aborted; step += 1) {
    const before = await embedderSaw()
    await page.mouse.move(clip.x + (step % 2), clip.y)
    if ((await embedderSaw()) === before) {
      return
    }
    if (Date.now() - started > INPUT_ROUTING_MS) {
      throw new Error(
        `[html-preview-render] ${arm} still handed its pointer input to the embedder after ${String(Date.now() - started)}ms`
      )
    }
    await abandonAfter(POLL_MS)
  }
}

const ADMITTED_IMAGE_PATHS = ['/css-bg.png', '/img.png']

// Poll listener in Node through arm-owned reader; require both admitted images instead of fixed 200ms settle that once saw only CSS background. Return on abort.
async function pollHitsUntilAdmitted(readImageHits, signal) {
  while (!signal?.aborted) {
    if (ADMITTED_IMAGE_PATHS.every((one) => readImageHits().includes(one))) {
      return
    }
    await abandonAfter(POLL_MS)
  }
}

// Diagnose complete/zero-width as failed decode, incomplete as inflight; currentSrc/loading distinguish unresolved/deferred URL from policy refusal.
async function describeAdmittedImages(page, readImageHits, describeRequests) {
  const frame = previewFrame(page)
  const image = frame
    ? await Promise.race([
        frame
          .evaluate(() => {
            const element = document.getElementById('remote')
            return element
              ? {
                  complete: element.complete,
                  naturalWidth: element.naturalWidth,
                  currentSrc: element.currentSrc,
                  loading: element.getAttribute('loading')
                }
              : null
          })
          .catch(() => 'the reading itself failed'),
        abandonAfter(EVALUATE_MS)
      ])
    : null
  const reading = image === false ? 'the reading never answered' : image
  // Browser request evidence distinguishes dropped-before-listener fetch from request never made.
  const requests = (await describeRequests?.(frame)) ?? 'no request log for this arm'
  return `the arm recorded ${JSON.stringify(readImageHits())} of ${JSON.stringify(ADMITTED_IMAGE_PATHS)}; #remote ${JSON.stringify(reading)}; ${requests}`
}

// No-navigation has no signal: allow two painted frames for dispatch plus 200ms for browser popup queue.
// Positive arms reading one on same counters keep absence checks honest; duration alone cannot prove observer works.
async function settleWithoutNavigation(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.waitForTimeout(200)
}

// Await expected navigation record itself; absence arms use bounded settle because nothing can signal no event.
export async function settleAfterMount(page, navigations, expectNavigation, signal, reading) {
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

// Expected navigation normally records at first check, including loaded runs; bound prevents missed 2s-actionability click consuming whole 120s case.
// Failure names arm/wait/click/frame; generous bound remains well inside case budget.
const NAVIGATION_RECORD_MS = 10_000

// Read after page request-event record; interception only refuses navigation.
// Round trips usually allow record before assertion even without wait; polling protects slower CI dispatch.
export async function waitForRecordedNavigation(
  page,
  navigations,
  matches,
  signal,
  reading,
  { sampleEveryMs = 5000, boundMs = NAVIGATION_RECORD_MS } = {}
) {
  // Reuse image/frame evidence for navigation arms that produced no request.
  const read = async () =>
    await describePreviewFrame(page, reading?.frame, reading?.browserVersion)
      .then(async (frameReading) => {
        const evidence = await reading?.describeRequests?.(reading?.frame)
        return evidence ? `${frameReading} | ${evidence}` : frameReading
      })
      .catch((error) => `the reading itself failed: ${String(error).split('\n')[0]}`)
  // Sample while waiting; reading after abort can lose teardown race and never print.
  let latest = 'no reading was taken before the case ended'
  const started = Date.now()
  let since = started
  // Include click outcome: clean click/no-navigation differs from rig actionability failure.
  const absent = (waited, last) =>
    `${reading?.arm ?? 'arm unknown'} waited ${String(waited)}ms for the navigation it expects ` +
    `and recorded ${JSON.stringify(navigations)}; its action ` +
    `${reading?.actError ? `failed with ${JSON.stringify(reading.actError)}` : 'reported no error'}` +
    ` | ${last}`
  while (!navigations.some((one) => matches(one))) {
    if (signal?.aborted) {
      console.error(`[html-preview-render] ${absent(Date.now() - started, latest)}`)
      return
    }
    const waited = Date.now() - started
    if (waited > boundMs) {
      // Read current frame at bound too; bound can be shorter than sampling interval, leaving placeholder otherwise.
      throw new Error(`[html-preview-render] ${absent(waited, await read())}`)
    }
    if (Date.now() - since > sampleEveryMs) {
      since = Date.now()
      latest = await read()
    }
    await page.waitForTimeout(10)
  }
}
