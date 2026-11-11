// Keep timeout/readings instrument separate from rig assertions; report why frame never became ready.

// Use case AbortSignal as sole timeout; sample while waiting, then print last reading before teardown can destroy frame.
// Do not throw after case abort: late unhandled rejection can fail otherwise passing suite.
export async function untilAborted(wait, signal, describe) {
  let latest = 'no reading was taken before the case ended'
  let sampling = true
  const sample = async () => {
    // Sample immediately and every five seconds so early timeout still has useful reading.
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
        // Already-aborted case has printed its diagnosis; do not emit duplicate wait reading.
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
  // Remove settled wait listener or later timeout prints obsolete successful wait’s sample.
  if (report) {
    signal?.removeEventListener('abort', report)
  }
}

// Combine embedder attributes, same-origin DOM access and CDP main-world readiness; each remains readable where another is blocked.
// Collect violations per frame (events do not cross frames). Bounded utilityWorld probe distinguishes selector-world failure from healthy main context.
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
        // Compare init-collector/script timestamps: listener cannot report violations emitted before attachment.
        initAt: window.__initAt ?? null,
        artifactAt: document.documentElement.dataset.artifactAt ?? null,
        violations: window.__violations ?? 'absent'
      }))
      .catch((error) => `evaluate refused: ${String(error).split('\n')[0]}`)
    // Bound isolated-world probe or diagnosis could hang as long as wait it explains.
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
