import { useEffect, useLayoutEffect, useRef } from 'react'

/** Advances when the composer moves to another send surface or unmounts, so a late send result can't act on the new one. */
export function useMobileNativeChatSendSurfaceGeneration(sendSurfaceId: string) {
  const mountedRef = useRef(true)
  const sendSurfaceIdRef = useRef(sendSurfaceId)
  const sendSurfaceGenerationRef = useRef(0)
  useLayoutEffect(() => {
    if (sendSurfaceIdRef.current !== sendSurfaceId) {
      sendSurfaceIdRef.current = sendSurfaceId
      sendSurfaceGenerationRef.current += 1
    }
  }, [sendSurfaceId])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sendSurfaceGenerationRef.current += 1
    }
  }, [])
  return { mountedRef, sendSurfaceGenerationRef }
}
