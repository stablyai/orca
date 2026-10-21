import type { RpcClient } from '../transport/rpc-client'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

/** A retired stream stays retired even when a cache clear reuses its numeric sequence. */
export function createMobileTerminalStreamLifetime(args: {
  isSubscriptionCurrent: () => boolean
  currentTerminal: () => TerminalWebViewHandle | undefined
  scheduleDelayedAction: (fn: () => void, ms: number) => void
  onEnd: () => void
}) {
  let ended = false
  let pendingFit = 0
  const isCurrent = () => !ended && args.isSubscriptionCurrent()
  return {
    isCurrent,
    end() {
      if (!ended) {
        ended = true
        args.onEnd()
      }
    },
    wrapUnsubscribe(unsubscribe: () => void) {
      return () => {
        ended = true
        unsubscribe()
      }
    },
    scheduleSettledFit(ref: TerminalWebViewHandle | undefined) {
      const requestedFit = ++pendingFit
      if (!ref) {
        return
      }
      // Only the latest accepted layout may refit the same document after settling.
      args.scheduleDelayedAction(() => {
        if (isCurrent() && pendingFit === requestedFit && args.currentTerminal() === ref) {
          ref.resetZoom()
        }
      }, 200)
    }
  }
}

export function subscribeMobileTerminalSafely(
  client: Pick<RpcClient, 'subscribe'>,
  params: unknown,
  onData: Parameters<RpcClient['subscribe']>[2],
  onSynchronousError: () => void
): () => void {
  try {
    return client.subscribe('terminal.subscribe', params, onData)
  } catch {
    // Why: a transport mock or closing socket can reject before returning an
    // unsubscribe handle; callers must still release their subscribing marker.
    onSynchronousError()
    return () => {}
  }
}
