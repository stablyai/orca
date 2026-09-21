/**
 * Why an image the policy admits was never fetched, asked of the frame that should have fetched it.
 *
 * The network log says whether a request happened. This says what the document thinks happened,
 * which is the other half: on CI's Chrome 152 the `<img>` reported `complete` with a zero
 * `naturalWidth` and a resolved `currentSrc` while no request was ever made, and those two readings
 * cannot both be true of a request that went out and failed.
 *
 * Every reading here is taken only when an arm has already aborted, so none of it costs a passing
 * run. The frame is reached through Playwright's CDP evaluate, which answers in a sandboxed frame
 * whose own scripts are blocked.
 */

/** Two seconds: long enough for a request to reach the asset listener, which is in this process. */
const FRESH_IMAGE_MS = 2000

/**
 * Every document commit in a subframe, counted from now.
 *
 * Subscribed at mount rather than read at the abort, because a parse leaves nothing behind to count:
 * a second document is a new window, so the init script's own timestamp is overwritten rather than
 * appended. Two commits would mean the artifact parsed twice and the second parse could be meeting a
 * failure the first one cached.
 */
function recordFrameParses(page) {
  const parses = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      return
    }
    parses.push({ url: frame.url(), at: Math.round(performance.now()) })
  })
  return () => [...parses]
}

/**
 * What the frame says about its images, and whether a request made right now is seen.
 *
 * The fresh image is the part that splits the two live explanations. Its URL has never existed, so
 * nothing can have cached a failure for it; if the rig sees that request and not the artifact's,
 * the frame can fetch and something about the parser-inserted element is the cause, and if the rig
 * sees neither, requests from this frame are not reaching the rig at all.
 */
async function describeImageEvidence(page, frame, { originPrefix, requestLog, parses, serverSaw }) {
  if (!frame) {
    return `no frame to ask; ${requestLog.describe()}`
  }
  const inFrame = await frame
    .evaluate(async () => {
      const remote = document.getElementById('remote')
      const decode = remote
        ? await remote.decode().then(
            () => 'resolved',
            (error) => `rejected ${error.name}`
          )
        : 'no element'
      return {
        readyState: document.readyState,
        initAt: window.__initAt ?? null,
        images: document.images.length,
        // Every subresource this document actually fetched, from the document's own side. An entry
        // here for a URL the rig never saw would mean the request left the frame and died before it.
        resources: performance.getEntriesByType('resource').map((one) => one.name),
        // The frame's own account of the entry, and only that. Readable at all because the asset
        // listener sends `Timing-Allow-Origin`: without it every field below reads zero for a
        // cross-origin resource, which was true of this reading until it was checked and would have
        // made a healthy request look like a failed one. Even with it, `responseStatus` still read
        // zero on a request that succeeded, so the discriminators are `transferSize`,
        // `encodedBodySize` and `nextHopProtocol`.
        //
        // `startTime` and `duration` are NOT comparable to any attachment time here: they are
        // relative to this document's navigation, while every `at` in the request log is Node's
        // `performance.now()`, relative to process start. The early-or-late question is answered on
        // the Node clock alone, by `asked` against `attached` in the request log.
        remoteTiming: performance
          .getEntriesByType('resource')
          .filter((one) => one.name === remote?.src)
          .map((one) => ({
            responseStatus: one.responseStatus ?? null,
            transferSize: one.transferSize,
            encodedBodySize: one.encodedBodySize,
            nextHopProtocol: one.nextHopProtocol,
            startTime: Math.round(one.startTime),
            duration: Math.round(one.duration)
          })),
        navigations: performance.getEntriesByType('navigation').map((one) => one.type),
        remote: remote
          ? {
              src: remote.getAttribute('src'),
              isConnected: remote.isConnected,
              complete: remote.complete,
              naturalWidth: remote.naturalWidth,
              currentSrc: remote.currentSrc,
              decode
            }
          : null
      }
    })
    .catch((error) => `the reading itself failed: ${String(error).split('\n')[0]}`)

  const freshPath = `/fresh-${String(Date.now())}.png`
  const freshUrl = `${originPrefix}${freshPath}`
  const issued = await frame
    .evaluate((url) => {
      const image = new Image()
      image.src = url
      globalThis.__freshImage = image
      return true
    }, freshUrl)
    .catch((error) => `the request itself failed: ${String(error).split('\n')[0]}`)
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, FRESH_IMAGE_MS)
    timer.unref?.()
  })
  const fresh = await frame
    .evaluate(() => {
      const image = globalThis.__freshImage
      return image ? { complete: image.complete, naturalWidth: image.naturalWidth } : null
    })
    .catch(() => null)

  return [
    `frame ${JSON.stringify(inFrame)}`,
    `subframe parses ${JSON.stringify(parses())}`,
    // "seen" is the listener's own record, which is the oracle every arm now reads; what the
    // browser-side log saw is reported beside it, since the two disagreeing is itself the finding.
    `fresh ${JSON.stringify(freshUrl)} issued ${JSON.stringify(issued)} served ${String(serverSaw?.(freshPath) ?? 'no server')} observed ${String(requestLog.asked().includes(freshUrl))} element ${JSON.stringify(fresh)}`,
    requestLog.describe()
  ].join('; ')
}

/**
 * Subscribes now and hands back the reading, so a caller wires one thing rather than three.
 *
 * The subscription is the only part that has to happen at mount; everything it reports is asked for
 * later, and only by an arm that aborted.
 */
export function watchImageEvidence(page, originPrefix, requestLog, serverSaw) {
  const parses = recordFrameParses(page)
  return async (frame) =>
    await describeImageEvidence(page, frame, { originPrefix, requestLog, parses, serverSaw })
}
