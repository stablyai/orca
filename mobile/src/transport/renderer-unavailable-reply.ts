import type { RpcResponse } from './types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

export function isRendererUnavailableReply(response: RpcResponse): boolean {
  return (
    !response.ok &&
    (response.error.code === RENDERER_UNAVAILABLE ||
      (response.error.code === 'runtime_error' && response.error.message === RENDERER_UNAVAILABLE))
  )
}
