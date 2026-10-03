import type { RpcResponse } from './types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

/**
 * A host with no desktop renderer (headless `orca serve`, orcad) refuses requests that open a
 * desktop tab with this; screens fall back to rendering the content on the device instead.
 * Current hosts wrap it as a `runtime_error` whose message is the code.
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
