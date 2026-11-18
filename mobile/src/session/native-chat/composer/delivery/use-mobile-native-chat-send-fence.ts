import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Fences a send against the composer unmounting or moving to another chat surface while it is in
 * flight: a send reads `generation` before it starts and acts on the result only if it still matches.
 */
export function useMobileNativeChatSendFence(sendSurfaceId: string): {
  readonly mountedRef: { readonly current: boolean }
  readonly generationRef: { readonly current: number }
} {
  const mountedRef = useRef(true)
  const surfaceIdRef = useRef(sendSurfaceId)
  const generationRef = useRef(0)
  useLayoutEffect(() => {
    if (surfaceIdRef.current !== sendSurfaceId) {
      surfaceIdRef.current = sendSurfaceId
      generationRef.current += 1
    }
  }, [sendSurfaceId])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])
  return { mountedRef, generationRef }
}
