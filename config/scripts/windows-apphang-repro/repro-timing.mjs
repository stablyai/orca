export const cdpPollTimeoutMs = 90_000
export const rendererActionTimeoutMs = 5_000
export const activationTimeoutMs = 15_000
export const ptyWaitTimeoutMs = 20_000
export const terminalMarkerTimeoutMs = 45_000
export const setupTimeoutMs = 90_000
export const appShutdownTimeoutMs = 8_000
export const severeRendererDriftMs = 2_000
export const severeActivationMs = 5_000
export const severeMainIpcMs = 2_000
export const severePtyWaitMs = 10_000

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runWithTimeout(label, action, timeoutMs) {
  const actionPromise = Promise.resolve().then(action)
  actionPromise.catch(() => undefined)
  const result = await Promise.race([
    actionPromise.then(
      (value) => ({ timedOut: false, value }),
      (error) => ({ timedOut: false, error })
    ),
    delay(timeoutMs).then(() => ({ timedOut: true }))
  ])
  if (result.timedOut) {
    throw new Error(`Timed out during ${label} after ${timeoutMs}ms.`)
  }
  if ('error' in result) {
    throw result.error
  }
  return result.value
}

export async function pollUntil(label, read, predicate, timeoutMs, intervalMs = 100) {
  const startedAt = Date.now()
  let lastValue = null
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await runWithTimeout(label, read, rendererActionTimeoutMs)
    if (predicate(lastValue)) {
      return lastValue
    }
    await delay(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`)
}
