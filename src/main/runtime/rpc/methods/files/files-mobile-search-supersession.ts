// Why: the host stops a search only when its socket closes, and a phone opens a new page (and a new
// client) per screen, so a phone's newer content search ends its older one here, where the process runs.
const running = new Map<string, AbortController>()

/** Claims the one search slot for `deviceKey`, aborting the device's earlier search; no key means no slot. */
export function claimMobileFileSearch(
  deviceKey: string | undefined,
  requestSignal: AbortSignal | undefined
): { signal: AbortSignal; release: () => void } | null {
  if (!deviceKey) {
    return null
  }
  running.get(deviceKey)?.abort()
  const controller = new AbortController()
  const onRequestAbort = (): void => controller.abort(requestSignal?.reason)
  if (requestSignal?.aborted) {
    controller.abort(requestSignal.reason)
  } else {
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
  }
  running.set(deviceKey, controller)
  return {
    signal: controller.signal,
    release: () => {
      requestSignal?.removeEventListener('abort', onRequestAbort)
      if (running.get(deviceKey) === controller) {
        running.delete(deviceKey)
      }
    }
  }
}
