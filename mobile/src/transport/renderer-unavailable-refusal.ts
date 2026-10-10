import type { RpcResponse } from './types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

// Current hosts wrap this refusal in runtime_error; older replies may carry it as the code.
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
