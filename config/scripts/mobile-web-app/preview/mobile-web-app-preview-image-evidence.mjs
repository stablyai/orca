// Failure-only CDP probe compares frame image state with request log: Chrome once reported complete/zero-width/resolved-src without emitting fetch.
// Evaluate works even when frame scripts are sandbox-blocked; passing arms pay no diagnostic-read cost.

// Allow local listener two seconds to observe fresh probe request.
const FRESH_IMAGE_MS = 2000

// Subscribe at mount to count subframe commits; reparsing resets window timestamp and may reuse cached failure, invisible to abort-only read.
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

// Fresh never-used URL distinguishes parser-image/cached failure from frame unable to reach listener at all.
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
        // Frame resource entry without listener hit means request left document but failed before server.
        resources: performance.getEntriesByType('resource').map((one) => one.name),
        // Timing-Allow-Origin exposes transferSize/encodedBodySize/protocol; responseStatus can remain zero even after success.
        // Frame startTime/duration use document-navigation clock, Node log uses process clock; compare asked/attached only within Node clock.
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
    // Listener hit is oracle; report browser log alongside because disagreement itself is finding.
    `fresh ${JSON.stringify(freshUrl)} issued ${JSON.stringify(issued)} served ${String(serverSaw?.(freshPath) ?? 'no server')} observed ${String(requestLog.asked().includes(freshUrl))} element ${JSON.stringify(fresh)}`,
    requestLog.describe()
  ].join('; ')
}

// Subscribe at mount, defer diagnostic reads until arm aborts.
export function watchImageEvidence(page, originPrefix, requestLog, serverSaw) {
  const parses = recordFrameParses(page)
  return async (frame) =>
    await describeImageEvidence(page, frame, { originPrefix, requestLog, parses, serverSaw })
}
