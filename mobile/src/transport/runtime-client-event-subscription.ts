import type { RuntimeClientEventStreamMessage } from '../../../src/shared/remote-runtime/session-graph/runtime-client-events'
import type { RpcClient } from './rpc/rpc-client-contract'

export type RuntimeClientEventHandlers = {
  /** Every ready; `replayed` once the stream reconnected, when changes in between sent no event. */
  onReady: (replayed: boolean) => void
  onLost?: () => void
  onEvent: (event: Exclude<RuntimeClientEventStreamMessage, { type: 'ready' | 'end' }>) => void
}

/** The host's change events, which each reader turns into its own re-reads. */
export function subscribeRuntimeClientEvents(
  client: Pick<RpcClient, 'subscribe'>,
  handlers: RuntimeClientEventHandlers
): () => void {
  let stale = false
  let ready = false
  const unsubscribe = client.subscribe(
    'runtime.clientEvents.subscribe',
    null,
    (payload: unknown) => {
      if (stale || !payload || typeof payload !== 'object') {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stream frames are host-typed; unknown types fall through every handler.
      const event = payload as RuntimeClientEventStreamMessage | { type: 'error' }
      if (event.type === 'ready') {
        const replayed = ready
        ready = true
        handlers.onReady(replayed)
        return
      }
      if (event.type === 'end' || event.type === 'error') {
        ready = false
        handlers.onLost?.()
        return
      }
      handlers.onEvent(event)
    }
  )
  return () => {
    stale = true
    unsubscribe()
  }
}
