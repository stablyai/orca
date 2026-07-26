import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { resolveMobileNativeChatTerminalStreamAction } from './mobile-native-chat-terminal-stream'

/** Pauses the active terminal stream while native chat covers its mounted WebView,
 *  then resumes from a fresh scrollback snapshot when terminal view returns. */
export function useMobileNativeChatTerminalStream(args: {
  showNativeChat: boolean
  activeHandle: string | null
  activeTabType: string | null
  subscriptionsRef: MutableRefObject<Map<string, () => void>>
  subscribingRef: MutableRefObject<Set<string>>
  webReadyRef: MutableRefObject<Set<string>>
  initializedRef: MutableRefObject<Set<string>>
  subscribe: (handle: string) => void
  unsubscribe: (handle: string) => void
}): (handle: string, wasAlreadyReady: boolean) => void {
  const coveredHandleRef = useRef<string | null>(null)
  const [webReadyRevision, setWebReadyRevision] = useState(0)
  const notifyWebReady = useCallback((handle: string, wasAlreadyReady: boolean) => {
    // Why: ordinary WebView startups must not rerender the large session route;
    // only readiness that can release a native-chat lease needs reconciliation.
    if (!wasAlreadyReady && coveredHandleRef.current === handle) {
      setWebReadyRevision((revision) => revision + 1)
    }
  }, [])
  useEffect(() => {
    const handle = args.activeHandle
    if (coveredHandleRef.current && coveredHandleRef.current !== handle) {
      coveredHandleRef.current = null
    }
    const streamActive =
      handle != null &&
      (args.subscriptionsRef.current.has(handle) || args.subscribingRef.current.has(handle))
    const action = resolveMobileNativeChatTerminalStreamAction({
      showNativeChat: args.showNativeChat,
      activeHandle: handle,
      activeTabType: args.activeTabType,
      streamActive,
      streamCovered: coveredHandleRef.current === handle,
      webViewReady: handle != null && args.webReadyRef.current.has(handle)
    })
    if (!handle || action === 'none') {
      return
    }
    if (action === 'pause') {
      coveredHandleRef.current = handle
      // Why: returning to terminal must accept the fresh scrollback snapshot;
      // the stream was paused while chat covered output that xterm never saw.
      args.initializedRef.current.delete(handle)
      // Why: covered chat needs the input-floor lease without paying to stream
      // duplicate PTY output. Replace any view stream with a lease-only stream.
      if (streamActive) {
        args.unsubscribe(handle)
      }
      args.subscribe(handle)
      return
    }
    if (coveredHandleRef.current === handle) {
      args.unsubscribe(handle)
      coveredHandleRef.current = null
    }
    args.subscribe(handle)
  }, [
    args.activeHandle,
    args.activeTabType,
    args.initializedRef,
    args.showNativeChat,
    args.subscribe,
    args.subscribingRef,
    args.subscriptionsRef,
    args.unsubscribe,
    args.webReadyRef,
    webReadyRevision
  ])
  return notifyWebReady
}
