// Use Node performance.now for asked/attached timestamps; frame resource clock is separate and must not be subtracted.
// Page request/failure plus Chromium CDP sent/loadingFailed reveal attempts, blocked/CORS reason and parser initiator.
// WebKit uses page events only. Collect arrays cheaply; format diagnostics only on failure.
export async function recordRequestsTo(page, originPrefix) {
  const asked = []
  const failed = []
  const sent = []
  const loadingFailed = []
  // Filter loadingFailed request IDs by origin: event has no URL and otherwise includes unrelated page traffic.
  const ours = new Set()
  const attached = []

  page.on('request', (request) => {
    if (request.url().startsWith(originPrefix)) {
      asked.push({ url: request.url(), at: Math.round(performance.now()) })
    }
  })
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
    // Chrome sandboxed frames use child processes, invisible to page CDP session; flattened auto-attach plus child Network.enable observes their requests.
    cdp.on('Target.attachedToTarget', (event) => {
      // Record exact child-attachment time on Node clock: request before listener attachment differs from policy refusal. Never compare frame resource timestamps.
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
