import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  isTerminalCoveredByNativeChat,
  mobileNativeChatTerminalRetryDelay,
  resolveMobileNativeChatTerminalStreamAction
} from './mobile-native-chat-terminal-stream'

export type MobileNativeChatTerminalStreamController = {
  notifyWebReady: (handle: string, wasAlreadyReady: boolean) => void
  notifyStreamReady: (handle: string) => void
  terminateStream: (handle: string, unsubscribe: (handle: string) => void) => void
  cancelRetry: (handle: string) => void
  clearRetries: () => void
}

type RetryEntry = {
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
}

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
  subscribe: (handle: string) => boolean | void
  unsubscribe: (handle: string) => void
  controllerRef?: MutableRefObject<MobileNativeChatTerminalStreamController | null>
}): MobileNativeChatTerminalStreamController {
  const coveredHandleRef = useRef<string | null>(null)
  const [webReadyRevision, setWebReadyRevision] = useState(0)
  const retryByHandleRef = useRef(new Map<string, RetryEntry>())
  const subscribeRef = useRef(args.subscribe)
  const stateRef = useRef({
    showNativeChat: args.showNativeChat,
    activeHandle: args.activeHandle,
    activeTabType: args.activeTabType
  })
  subscribeRef.current = args.subscribe
  stateRef.current = {
    showNativeChat: args.showNativeChat,
    activeHandle: args.activeHandle,
    activeTabType: args.activeTabType
  }

  const cancelRetry = useCallback((handle: string) => {
    const retry = retryByHandleRef.current.get(handle)
    if (retry?.timer) {
      clearTimeout(retry.timer)
    }
    retryByHandleRef.current.delete(handle)
  }, [])
  const clearRetries = useCallback(() => {
    for (const retry of retryByHandleRef.current.values()) {
      if (retry.timer) {
        clearTimeout(retry.timer)
      }
    }
    retryByHandleRef.current.clear()
  }, [])
  const scheduleRetryRef = useRef<(handle: string) => void>(() => {})
  const scheduleRetry = useCallback(
    (handle: string) => {
      const current = retryByHandleRef.current.get(handle)
      if (current?.timer) {
        return
      }
      const attempt = current?.attempt ?? 0
      const timer = setTimeout(() => {
        retryByHandleRef.current.set(handle, { attempt: attempt + 1, timer: null })
        const state = stateRef.current
        if (
          state.activeTabType !== 'terminal' ||
          !isTerminalCoveredByNativeChat(state.showNativeChat, state.activeHandle, handle)
        ) {
          cancelRetry(handle)
          return
        }
        if (subscribeRef.current(handle) === false) {
          scheduleRetryRef.current(handle)
        }
      }, mobileNativeChatTerminalRetryDelay(attempt))
      retryByHandleRef.current.set(handle, { attempt, timer })
    },
    [cancelRetry]
  )
  scheduleRetryRef.current = scheduleRetry

  const notifyWebReady = useCallback((handle: string, wasAlreadyReady: boolean) => {
    // Why: ordinary WebView startups must not rerender the large session route;
    // only readiness that can release a native-chat lease needs reconciliation.
    if (!wasAlreadyReady && coveredHandleRef.current === handle) {
      setWebReadyRevision((revision) => revision + 1)
    }
  }, [])
  const notifyStreamReady = useCallback(
    (handle: string) => {
      cancelRetry(handle)
    },
    [cancelRetry]
  )
  const terminateStream = useCallback(
    (handle: string, unsubscribe: (handle: string) => void) => {
      unsubscribe(handle)
      const state = stateRef.current
      if (
        state.activeTabType !== 'terminal' ||
        !isTerminalCoveredByNativeChat(state.showNativeChat, state.activeHandle, handle)
      ) {
        cancelRetry(handle)
        return
      }
      scheduleRetry(handle)
    },
    [cancelRetry, scheduleRetry]
  )

  useEffect(() => clearRetries, [clearRetries])
  useEffect(() => {
    const handle = args.activeHandle
    if (coveredHandleRef.current && coveredHandleRef.current !== handle) {
      cancelRetry(coveredHandleRef.current)
      coveredHandleRef.current = null
    }
    for (const retryHandle of retryByHandleRef.current.keys()) {
      if (!isTerminalCoveredByNativeChat(args.showNativeChat, handle, retryHandle)) {
        cancelRetry(retryHandle)
      }
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
      cancelRetry(handle)
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
      cancelRetry(handle)
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
    cancelRetry,
    webReadyRevision
  ])
  const controller = useMemo(
    () => ({
      notifyWebReady,
      notifyStreamReady,
      terminateStream,
      cancelRetry,
      clearRetries
    }),
    [cancelRetry, clearRetries, notifyStreamReady, notifyWebReady, terminateStream]
  )
  if (args.controllerRef) {
    args.controllerRef.current = controller
  }
  return controller
}
