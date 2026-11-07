import type { RpcClient } from '../transport/rpc-client'
import type { Dispatch, SetStateAction } from 'react'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { MobileDisplayMode } from './mobile-session-route-types'

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
    // Synchronous subscribe failures still need to release the subscribing marker.
    onSynchronousError()
    return () => {}
  }
}

// Another surface of this phone took the stream; remember it so this one yields instead of rearming.
export function noteTerminalStreamTakeover(
  data: Readonly<Record<string, unknown>>,
  handle: string,
  replacedHandles: Set<string>
): void {
  if (data.type === 'end' && data.reason === 'replaced') {
    replacedHandles.add(handle)
  }
}

export function adoptTerminalDisplayMode(
  setTerminalModes: Dispatch<SetStateAction<Map<string, MobileDisplayMode>>>,
  handle: string,
  displayMode: unknown
): void {
  if (displayMode !== 'auto' && displayMode !== 'phone' && displayMode !== 'desktop') {
    return
  }
  // Reuse mode Map on no-op frames so every stream pass cannot rerender the route.
  setTerminalModes((prev) =>
    prev.get(handle) === displayMode ? prev : new Map(prev).set(handle, displayMode)
  )
}
