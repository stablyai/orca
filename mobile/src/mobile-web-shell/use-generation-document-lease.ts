import { useCallback, useEffect, useRef } from 'react'
import type { GenerationLease, GenerationStore } from './generation-store'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

export function useGenerationDocumentLease(
  store: GenerationStore,
  renderedState: MobileWebShellSessionState
) {
  const leaseRef = useRef<GenerationLease | null>(null)
  const retired = useRef(new Map<GenerationLease, MobileWebShellSessionState>())
  const retireLease = useCallback((state: MobileWebShellSessionState) => {
    if (leaseRef.current !== null) {
      retired.current.set(leaseRef.current, state)
      leaseRef.current = null
    }
  }, [])
  const adoptLease = useCallback(
    (lease: GenerationLease, previousState: MobileWebShellSessionState) => {
      retireLease(previousState)
      leaseRef.current = lease
    },
    [retireLease]
  )

  // Invalidate confirmation immediately; keep bytes pinned until React removes the retired view.
  useEffect(() => {
    for (const [lease, state] of retired.current) {
      if (state !== renderedState) {
        store.releaseGeneration(lease)
        retired.current.delete(lease)
      }
    }
  }, [renderedState, store])
  useEffect(
    () => () => {
      if (leaseRef.current !== null) {
        store.releaseGeneration(leaseRef.current)
      }
      for (const lease of retired.current.keys()) {
        store.releaseGeneration(lease)
      }
      leaseRef.current = null
      retired.current.clear()
    },
    [store]
  )
  return { leaseRef, retireLease, adoptLease }
}
