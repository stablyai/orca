import { useEffect, useRef } from 'react'
import { mobileScrollCache, setWithLRU } from '../lib/mobile-scroll-cache'

/**
 * Track scroll position for a component and persist across unmount/remount.
 * Returns a ref to store the current scrollY and a cache key to use.
 */
export function useMobileScrollPersistence(cacheKey: string) {
  const scrollYRef = useRef(0)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Save on unmount.
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current !== null) {
        clearTimeout(throttleTimerRef.current)
      }
      if (scrollYRef.current > 0) {
        setWithLRU(mobileScrollCache, cacheKey, scrollYRef.current)
      }
    }
  }, [cacheKey])

  const captureScroll = useRef((y: number) => {
    scrollYRef.current = y
    if (throttleTimerRef.current !== null) {
      return
    }
    throttleTimerRef.current = setTimeout(() => {
      throttleTimerRef.current = null
      setWithLRU(mobileScrollCache, cacheKey, scrollYRef.current)
    }, 200)
  }).current

  const restoreScrollY = mobileScrollCache.get(cacheKey)

  return { captureScroll, restoreScrollY }
}
