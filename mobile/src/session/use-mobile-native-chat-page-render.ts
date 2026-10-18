import { useCallback, useRef, useSyncExternalStore } from 'react'

/** Renders the caller again from any event source (a scroll, the observer, a timer) synchronously,
 *  so a window change is in the document before the browser paints. */
export function useMobileNativeChatPageRender(): () => void {
  const store = useRef({ version: 0, notify: () => {} })
  const subscribe = useCallback((notify: () => void) => {
    store.current.notify = notify
    return () => {
      store.current.notify = () => {}
    }
  }, [])
  useSyncExternalStore(subscribe, () => store.current.version)
  return useCallback(() => {
    store.current.version += 1
    store.current.notify()
  }, [])
}
