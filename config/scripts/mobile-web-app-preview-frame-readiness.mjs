/**
 * Where the render rig decides a preview frame is ready, and the world it asks in.
 *
 * Every wait here is `frame.evaluate`, which needs only the frame's own main execution context.
 * Playwright's `waitForSelector` and `waitForFunction` need its injected script as well, and
 * `waitForSelector` needs that script in the utility world -- an isolated world Chromium creates per
 * document through a command whose failure is swallowed and whose creation event is dropped for a
 * frame the driver considers stale. With `timeout: 0` a world that never arrives is a wait that
 * never ends, which is what three cases did on CI's Chrome while an evaluate in the same frame
 * reported the marker already present. The diagnosis prints a bounded probe of that world now, so
 * the next run measures it rather than inferring it.
 *
 * The frame is resolved again on every attempt rather than bound once, so a document committed after
 * a wait began is the one the predicate runs in.
 */

import { describePreviewFrame, untilAborted } from './mobile-web-app-preview-frame-diagnosis.mjs'
import { pollReportsUntil } from './mobile-web-app-preview-csp-reports.mjs'

const POLL_MS = 25
const EVALUATE_MS = 1000

/** The mounted preview frame, or null before one exists. */
export function previewFrame(page) {
  return page.frames().find((one) => one !== page.mainFrame()) ?? null
}

const abandonAfter = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
  })

/**
 * Polls `predicate` inside the preview frame until it holds or the case ends.
 *
 * Returns rather than throws when the signal aborts: `untilAborted` has already printed the reading
 * by then, and a rejection raised after vitest has given up has nobody left to catch it.
 */
export async function pollFrameUntil(page, predicate, signal) {
  while (!signal?.aborted) {
    const frame = previewFrame(page)
    // An evaluate carries no timeout of its own and waits on the frame's main context, so one that
    // never answers is abandoned here rather than outliving the frame it was asked of.
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

/**
 * The mounted frame, once it holds the artifact.
 *
 * Found among the page's frames, never by its URL. A `srcdoc` frame reports `about:srcdoc` on both
 * engines here and an empty URL on CI's browser, and a poll that waited for the string spent every
 * case's whole timeout there -- seven timeouts on one engine, after the same difference had already
 * shown up as `expected '' to be 'about:srcdoc'`.
 *
 * Every wait below asks in the frame's main world through `pollFrameUntil`, for the reason that
 * module carries: a selector wait needs an isolated world the embedder cannot see fail.
 *
 * Three things still settle at their own moments: React commits the mount, the element's `srcdoc`
 * commits a document, and an override arm replaces that document with a second one. So readiness is
 * the fixture's own marker inside the frame, which exists only once the artifact has parsed there.
 *
 * `frameReady` is which of those an arm is waiting for, because the marker is not always the right
 * one. `'script'` waits for what the inline script writes, on the document element rather than on a
 * window global: the marker element exists from parse time, so an arm whose oracle is "the script
 * ran" would otherwise read the flag before it was written. `'load'` is for the one arm whose
 * artifact deliberately navigates the frame somewhere else, where no marker is ever coming.
 *
 * `reportReady` is the other kind of precondition: a refusal the policy reported to the rig's own
 * server, which an arm about what the policy refused waits for instead of reading a list.
 */
export async function waitForLoadedFrame(
  page,
  { frameReady = 'artifact', reportReady = null, signal, browserVersion, arm, sink, nonce }
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
  await frame.waitForLoadState('load').catch(() => {})
  if (frameReady === 'script') {
    await untilAborted(
      pollFrameUntil(page, () => document.documentElement.dataset.ran === '1', signal),
      signal,
      async () => await reading("the artifact's script never ran inside the frame")
    )
  }
  if (reportReady) {
    // The browser's own report, not the frame's listener. An arm whose claim is "the policy refused
    // this" waits for the refusal to have been reported, which is evidence no in-frame listener has
    // to have been installed in time to collect -- and in a frame with no `allow-scripts` none ever
    // is. The wait ends in the diagnosis rather than in a passing read.
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
  return previewFrame(page)
}
