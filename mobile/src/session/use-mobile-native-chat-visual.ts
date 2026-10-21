import { useCallback, useEffect, useState } from 'react'
import {
  cachedMobileNativeChatVisual,
  readMobileNativeChatVisual,
  type MobileNativeChatVisualSource
} from './mobile-native-chat-visual-read'

export type MobileNativeChatVisualState =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string; revision: string }
  | { kind: 'unavailable' }

/** Automatic re-asks after a read that got no answer; the reader's tap starts a fresh round. */
const AUTO_RETRY_DELAYS_MS = [1_500, 5_000] as const

function initialState(
  source: MobileNativeChatVisualSource,
  file: string
): MobileNativeChatVisualState {
  const cached = cachedMobileNativeChatVisual(source, file)
  return cached ? { kind: 'ready', ...cached } : { kind: 'loading' }
}

/**
 * One visual's content: painted from the phone's cache when it has one, revalidated against the
 * owning host on every mount, and retried a bounded number of times when the host does not answer.
 * Nothing latches: `retry` (or a new client after a reconnect) asks again.
 */
export function useMobileNativeChatVisual(
  source: MobileNativeChatVisualSource,
  file: string
): { state: MobileNativeChatVisualState; retry: () => void } {
  const [state, setState] = useState(() => initialState(source, file))
  // `round` is a reader's retry; `retriesUsed` counts automatic re-asks within it.
  const [request, setRequest] = useState({ round: 0, retriesUsed: 0 })
  const [retryInMs, setRetryInMs] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    void readMobileNativeChatVisual(source, file).then((read) => {
      if (disposed) {
        return
      }
      if (read.kind === 'ready') {
        // Same revision keeps the same state object, so the frame does not reload its document.
        setState((current) =>
          current.kind === 'ready' && current.revision === read.revision
            ? current
            : { kind: 'ready', html: read.html, revision: read.revision }
        )
        return
      }
      const delay =
        read.kind === 'unreachable' ? AUTO_RETRY_DELAYS_MS[request.retriesUsed] : undefined
      if (delay !== undefined) {
        setRetryInMs(delay)
        return
      }
      // A host that does not answer leaves a visual on screen; one that refuses it takes it down.
      setState((current) =>
        current.kind === 'ready' && read.kind === 'unreachable' ? current : { kind: 'unavailable' }
      )
    })
    return () => {
      disposed = true
    }
  }, [source, file, request])

  useEffect(() => {
    if (retryInMs === null) {
      return
    }
    const timer = setTimeout(() => {
      setRetryInMs(null)
      setRequest((current) => ({ ...current, retriesUsed: current.retriesUsed + 1 }))
    }, retryInMs)
    return () => clearTimeout(timer)
  }, [retryInMs])

  const retry = useCallback(() => {
    setState((current) => (current.kind === 'unavailable' ? { kind: 'loading' } : current))
    setRetryInMs(null)
    setRequest((current) => ({ round: current.round + 1, retriesUsed: 0 }))
  }, [])

  return { state, retry }
}
