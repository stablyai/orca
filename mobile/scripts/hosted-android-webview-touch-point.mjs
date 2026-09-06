export async function readStableHostedAndroidWebViewPoint(
  readPoint,
  { stableMs = 2_000, timeoutMs = 7_000 } = {}
) {
  const deadline = Date.now() + timeoutMs
  let previous
  let stableSince = 0
  while (Date.now() < deadline) {
    const current = await readPoint()
    if (
      previous &&
      Math.abs(current.x - previous.x) <= 0.005 &&
      Math.abs(current.y - previous.y) <= 0.005
    ) {
      stableSince ||= Date.now()
      if (Date.now() - stableSince >= stableMs) {
        return current
      }
    } else {
      stableSince = 0
    }
    previous = current
    await delay(250)
  }
  throw new Error('Hosted Android WebView touch point did not stabilize')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
