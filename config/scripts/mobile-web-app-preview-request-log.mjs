/**
 * What the browser said about every request to one origin, for an arm that expected one and did not
 * get it.
 *
 * Every `at` recorded here is Node's `performance.now()`, so `asked` and `attached` can be read
 * against each other and the early-or-late question is answered on one clock. Readings taken inside
 * the frame are on the document's clock and belong beside these, never subtracted from them.
 *
 * Four sources, because each is blind where the others see. `request` fires for what the page asked
 * for at all, which separates a request the policy refused from one nothing ever made.
 * `requestfailed` carries the browser's own `errorText`. CDP's `Network.loadingFailed` adds
 * `blockedReason` and `corsErrorStatus`, which is the only place a refusal names itself when the
 * request never reached the asset listener. `Network.requestWillBeSent` records the resource type, the
 * initiator and the frame, which separates an image the parser found from one nothing asked for.
 *
 * CDP is Chromium's; WebKit has no session to open here, and the two page events carry that engine.
 *
 * Recorded into arrays and formatted only when asked, so an arm that passes pays for the
 * subscription and never for the reading.
 */
export async function recordRequestsTo(page, originPrefix) {
  const asked = []
  const failed = []
  const sent = []
  const loadingFailed = []
  // Only this origin's ids, because `Network.loadingFailed` carries a request id and no URL, and an
  // unfiltered list would report every other request on the page as this arm's evidence.
  const ours = new Set()
  /** Every child target this session attached to, which says whether the frame is out of process. */
  const attached = []

  page.on('request', (request) => {
    if (request.url().startsWith(originPrefix)) {
      asked.push({ url: request.url(), at: Math.round(performance.now()) })
    }
  })
  // When this page first had any frame at all, so an attachment time has something to be early or
  // late against.
  const frameAttached = []
  page.on('frameattached', (frame) => {
    frameAttached.push({ url: frame.url(), at: Math.round(performance.now()) })
  })
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(originPrefix)) {
      failed.push({ url: request.url(), errorText: request.failure()?.errorText ?? null })
    }
  })

  const cdp = await page
    .context()
    .newCDPSession(page)
    .catch(() => null)
  if (cdp) {
    await cdp.send('Network.enable').catch(() => {})
    // Chromium isolates sandboxed iframes into their own process, srcdoc included, so the page's own
    // session sees none of the frame's requests: `cdp sent` came back empty on CI even for a request
    // Playwright did record. Flattened auto-attach puts each child target on this same connection,
    // and `Network.enable` on the child is what makes its requests visible here.
    cdp.on('Target.attachedToTarget', (event) => {
      // The moment, not just the fact. This and every `at` on `asked` come from the same Node
      // clock, which is what makes them comparable: a request recorded before the frame's target
      // was attached was issued while nothing was listening to that frame, and that is a different
      // bug from a refusal. Nothing here is comparable to the frame's own resource timing, which
      // counts from that document's navigation.
      attached.push({
        type: event.targetInfo?.type ?? null,
        url: event.targetInfo?.url ?? null,
        at: Math.round(performance.now())
      })
      cdp.send('Network.enable', {}, event.sessionId).catch(() => {})
    })
    await cdp
      .send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      })
      .catch(() => {})
    cdp.on('Network.requestWillBeSent', (event) => {
      if (!event.request?.url?.startsWith(originPrefix)) {
        return
      }
      ours.add(event.requestId)
      sent.push({
        url: event.request.url,
        type: event.type ?? null,
        initiator: event.initiator?.type ?? null,
        frameId: event.frameId ?? null
      })
    })
    cdp.on('Network.loadingFailed', (event) => {
      if (!ours.has(event.requestId)) {
        return
      }
      loadingFailed.push({
        errorText: event.errorText ?? null,
        blockedReason: event.blockedReason ?? null,
        corsErrorStatus: event.corsErrorStatus ?? null,
        type: event.type ?? null
      })
    })
  }

  return {
    asked: () => asked.map((one) => one.url),
    describe: () =>
      `asked ${JSON.stringify(asked)}; failed ${JSON.stringify(failed)}; frameAttached ${JSON.stringify(frameAttached)}; cdp ${cdp ? 'on' : 'off'} attached ${JSON.stringify(attached)} sent ${JSON.stringify(sent)}; cdp loadingFailed ${JSON.stringify(loadingFailed)}`
  }
}
