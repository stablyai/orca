import { useCallback, useEffect, useRef } from 'react'
import { mobileScrollCache, setWithLRU } from '../lib/mobile-scroll-cache'

/**
 * Track scroll position for a component and persist across unmount/remount.
 * Returns a capture callback and the cached scrollY to restore.
 */
export function useMobileScrollPersistence(cacheKey: string) {
  const scrollYRef = useRef(0)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cacheKeyRef = useRef(cacheKey)
  cacheKeyRef.current = cacheKey

  // Reset on key change so a leftover scrollY from the previous key is never
  // written under the new key by the unmount flush or a pending throttle timer.
  useEffect(() => {
    scrollYRef.current = 0
    if (throttleTimerRef.current !== null) {
      clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }
  }, [cacheKey])

  useEffect(() => {
    return () => {
      if (throttleTimerRef.current !== null) {
        clearTimeout(throttleTimerRef.current)
      }
      if (scrollYRef.current > 0) {
        setWithLRU(mobileScrollCache, cacheKeyRef.current, scrollYRef.current)
      }
    }
  }, [])

  const captureScroll = useCallback((y: number) => {
    scrollYRef.current = y
    if (throttleTimerRef.current !== null) {
      return
    }
    throttleTimerRef.current = setTimeout(() => {
      throttleTimerRef.current = null
      setWithLRU(mobileScrollCache, cacheKeyRef.current, scrollYRef.current)
    }, 200)
  }, [])

  const restoreScrollY = mobileScrollCache.get(cacheKey)

  return { captureScroll, restoreScrollY }
}
