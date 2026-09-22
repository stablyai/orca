/**
 * Where the render rig decides a preview frame is ready and when an arm's counters may be read, and
 * the world it asks in.
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
 *
 * `'images'` is the mirror of `reportReady`: an arm whose claim is that the policy admitted two
 * image requests waits for both to have been recorded, rather than reading a count after a clock.
 */
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
  // Bound to the case like every other wait here: `waitForLoadState` carries its own timeout and
  // goes on waiting after the case has been aborted.
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
  // After the marker, because an image is requested by a document that has parsed.
  if (frameReady === 'images') {
    await untilAborted(
      pollHitsUntilAdmitted(readImageHits, signal),
      signal,
      async () => await reading(await describeAdmittedImages(page, readImageHits, describeRequests))
    )
  }
  return previewFrame(page)
}

/** The two the widened `img-src` admits; the font beside them stays an absence. */
const ADMITTED_IMAGE_PATHS = ['/css-bg.png', '/img.png']

/**
 * Both admitted image requests, once the rig has recorded them.
 *
 * Polled in Node rather than in the frame, because the asset listener records there, and the arm
 * hands its own reader in so this module keeps no arm's state. Returns rather than throws when the
 * case ends, like every wait here.
 *
 * Why a wait at all: the bounded settle these arms used to take is absence-shaped, two frames and
 * 200 ms, and their claim is a presence. CI's Chrome 152 had recorded the CSS background and not
 * the `<img>` when that clock expired, which a count cannot tell from a refusal.
 */
async function pollHitsUntilAdmitted(readImageHits, signal) {
  while (!signal?.aborted) {
    if (ADMITTED_IMAGE_PATHS.every((one) => readImageHits().includes(one))) {
      return
    }
    await abandonAfter(POLL_MS)
  }
}

/**
 * Why the images are not both there, read from the element the browser would have fetched for.
 *
 * `complete` with a zero `naturalWidth` is a request that finished and produced no image, which is
 * what a refusal looks like from the element; `complete` false is one still in flight; `currentSrc`
 * separates both from an element that never resolved a URL, and `loading` from one the browser
 * deferred. Without these a CI log says only that a count was 1.
 */
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
  // What the browser said about the requests themselves, which is where a request that never
  // reached the asset listener is distinguishable from one the page never made.
  const requests = (await describeRequests?.(frame)) ?? 'no request log for this arm'
  return `the arm recorded ${JSON.stringify(readImageHits())} of ${JSON.stringify(ADMITTED_IMAGE_PATHS)}; #remote ${JSON.stringify(reading)}; ${requests}`
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

/**
 * Where an arm's counters are read: after the thing it is about, whatever that thing is.
 *
 * `expectNavigation` names what the arm is waiting for, and an arm that expects one waits for the
 * record itself rather than for a clock. An arm that expects none has nothing to await, so it takes
 * the bounded path below.
 */
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

/**
 * The moment the arm's navigation exists, for an arm that expects one.
 *
 * No clock at all: the rig's `page.on('request')` subscription records a main-frame navigation as
 * the browser dispatches it, so the oracles are read after the thing under test rather than after a
 * wait, and the only bound is the case's own timeout through `ctx.signal`. The route beside it only
 * refuses the navigation; it stopped counting anything when the record moved off interception. An arm whose click missed its target prints
 * what it did record and lets the case fail as the timeout it is.
 *
 * Measured, so it is not sold as more than it is: with this replaced by a no-op every arm still
 * passes, because the reads that follow are each a round trip and the record lands during them. It is
 * the load the CI runner was under that this is for, which is the same condition that produced the
 * frame-commit race above.
 */
export async function waitForRecordedNavigation(
  page,
  navigations,
  matches,
  signal,
  reading,
  sampleEveryMs = 5000
) {
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
    if (Date.now() - since > sampleEveryMs) {
      since = Date.now()
      latest = await describePreviewFrame(page, reading?.frame, reading?.browserVersion)
        .then(async (frameReading) => {
          // The same evidence the images arm prints. A navigation arm that produced nothing is
          // asking the same question of the same frame, and on CI this one fails on its own.
          const evidence = await reading?.describeRequests?.(reading?.frame)
          return evidence ? `${frameReading} | ${evidence}` : frameReading
        })
        .catch((error) => `the reading itself failed: ${String(error).split('\n')[0]}`)
    }
    await page.waitForTimeout(10)
  }
}
