/**
 * What the HTML preview's render rig can still read when a frame never becomes ready, and the bound
 * it reads at.
 *
 * Separate from the test file because the file is at its line limit and because these two are one
 * thing: a wait that ends only with the case, and the reading it prints when it does. The rig's
 * claims stay in the test; this is the instrument that reports why one could not be made.
 */

/**
 * A wait bounded by the case's own timeout and by nothing else.
 *
 * `ctx.signal` aborts when vitest times a case out, so no number in here races the one the case
 * declares. On abort the rig prints what the frame reported -- the reading that tells a frame the
 * policy refused from one that was merely slow, which is what CI's chromium timeouts could not say.
 *
 * The reading is sampled while waiting and printed from the last sample, never read at the abort:
 * a reading taken after the case has timed out loses its race with vitest's teardown, which is how
 * a first attempt at this printed nothing at all. Nothing is rethrown either -- a rejection raised
 * after vitest has given up has nobody left to catch it, and an unhandled one fails a run whose
 * every test passed.
 */
export async function untilAborted(wait, signal, describe) {
  let latest = 'no reading was taken before the case ended'
  let sampling = true
  const sample = async () => {
    // Once at the start and then every five seconds, so a case that ends early still has a reading to
    // print. A wait that only ever prints "no reading was taken" tells nobody anything.
    while (sampling) {
      latest = await describe().catch(
        (error) => `the reading itself failed: ${String(error).split('\n')[0]}`
      )
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
  void sample()
  let report = null
  await Promise.race([
    wait,
    new Promise((resolve) => {
      if (!signal) {
        return
      }
      if (signal.aborted) {
        // Silent: the case was already over when this wait began, so it has nothing of its own to
        // report and the wait that did time out has already printed its reading.
        resolve()
        return
      }
      report = () => {
        console.error(`[html-preview-render] ${latest}`)
        resolve()
      }
      signal.addEventListener('abort', report, { once: true })
    })
  ]).catch(() => {})
  sampling = false
  // Dropped on the way out, so the wait that hung is the only one that speaks: a listener left by a
  // wait that resolved prints its own stale reading at a later wait's timeout.
  if (report) {
    signal?.removeEventListener('abort', report)
  }
}

/**
 * Everything a frame that never became ready can still be asked, which is the whole diagnosis when
 * the only oracle is a runner.
 *
 * Three readings, because each is blind where the others see. The element's own attributes come from
 * the embedder and survive a frame that never parsed. `contentDocument` and `contentWindow` answer
 * only for a frame granted `allow-same-origin`, and say `refused` for the opaque ones, which is
 * itself the answer to "is this arm same-origin". And every Playwright frame is evaluated through
 * CDP, which reaches an opaque frame whose own scripts are blocked, so `readyState` separates a
 * document that never parsed from one that parsed and did nothing.
 *
 * The violations are read per frame rather than from the top. `securitypolicyviolation` does not
 * cross frames, so the top document's array says nothing about what the frame refused -- and the
 * page's init script installs the same collector in every frame, measured on both engines, so each
 * frame has its own array to report.
 *
 * `utilityWorld` is the fourth reading, and it is the one the readings above cannot give. Everything
 * else here is an evaluate, which needs only a frame's main context; a selector wait needs the
 * injected script in Chromium's isolated world, created per document by a command whose failure the
 * driver swallows. Three cases once spent their whole timeout in such a wait while an evaluate in
 * the same frame answered, so the probe is bounded and reported rather than left to be inferred
 * again. `unavailable` here and a main-world reading beside it is that split, measured.
 */
export async function describePreviewFrame(page, frame, browserVersion) {
  const host = await page
    .evaluate(() => {
      const element = document.querySelector('iframe')
      const reach = (read) => {
        try {
          return read() ?? null
        } catch {
          return 'refused'
        }
      }
      return {
        srcdocChars: element?.getAttribute('srcdoc')?.length ?? null,
        sandbox: element?.getAttribute('sandbox') ?? null,
        contentReadyState: reach(() => element?.contentDocument?.readyState),
        contentHref: reach(() => element?.contentWindow?.location.href),
        topViolations: window.__violations ?? null
      }
    })
    .catch((error) => `page refused: ${String(error).split('\n')[0]}`)
  const frames = []
  for (const one of page.frames()) {
    const reading = await one
      .evaluate(() => ({
        readyState: document.readyState,
        bodyChars: document.body?.innerHTML.length ?? null,
        marker: document.getElementById('marker') !== null,
        ran: document.documentElement.dataset.ran ?? null,
        // The order the collector's own reach depends on: when the page's init script ran here and
        // when the artifact's script did. A listener installed after the parser reached the inline
        // script can only report what came later.
        initAt: window.__initAt ?? null,
        artifactAt: document.documentElement.dataset.artifactAt ?? null,
        violations: window.__violations ?? 'absent'
      }))
      .catch((error) => `evaluate refused: ${String(error).split('\n')[0]}`)
    // Bounded, and the only wait in the diagnosis: a frame whose isolated world never arrives would
    // otherwise hold the reading open for as long as the wait it is explaining.
    const utilityWorld = await one
      .locator('html')
      .waitFor({ state: 'attached', timeout: 2000 })
      .then(() => 'resolved')
      .catch((error) => `unavailable: ${String(error).split('\n')[0]}`)
    frames.push(
      `${JSON.stringify(one.url())} name ${JSON.stringify(one.name())} utilityWorld ${JSON.stringify(utilityWorld)} ${JSON.stringify(reading)}`
    )
  }
  return [
    `browser ${browserVersion ?? 'unknown'}`,
    `awaited frame url ${JSON.stringify(frame?.url() ?? null)}`,
    `host ${JSON.stringify(host)}`,
    `frames [${frames.join(' ;; ')}]`
  ].join(' | ')
}
