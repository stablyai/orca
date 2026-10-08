import type { RpcResponse } from './types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

/**
 * An older host with no desktop window refuses requests that open or read an editor tab with this;
 * screens fall back to rendering the content on the device instead. Hosts wrap it as a
 * `runtime_error` whose message is the code. Exact match only: `runtime_unavailable`, timeouts,
 * disconnects and browser-bridge codes are different failures and must not trigger a fallback.
 */
export function isRendererUnavailableRefusal(response: RpcResponse): boolean {
  if (response.ok) {
    return false
  }
  // Why optional: replies cross the wire unvalidated, and a malformed refusal is simply not this one.
  const { code, message } = response.error ?? {}
  return (
    code === RENDERER_UNAVAILABLE || (code === 'runtime_error' && message === RENDERER_UNAVAILABLE)
  )
}
