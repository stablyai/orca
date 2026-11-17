import { useEffect, useRef } from 'react'

// A host-area page's own hops never move the native route; reopen the last one natively once the layout narrows (a fold), or the phone shows the list beneath.
// Only the focused screen acts: a host-route shell left under a pushed session also folds, and must not pop the stack back to itself.
export function usePageLocationOnFold(
  isWideLayout: boolean,
  isFocused: () => boolean,
  openPageRoute: (href: string) => void
): (href: string, ownsHostArea: boolean) => void {
  // Refresh after commit, before the fold effect below reads them; a discarded render must not swap the handlers.
  const latest = useRef({ openPageRoute, isFocused })
  useEffect(() => {
    latest.current = { openPageRoute, isFocused }
  })
  const heldRef = useRef<string | null>(null)
  const wasWideRef = useRef(isWideLayout)
  useEffect(() => {
    if (wasWideRef.current === isWideLayout) {
      return
    }
    wasWideRef.current = isWideLayout
    const held = heldRef.current
    heldRef.current = null
    if (!isWideLayout && held !== null && latest.current.isFocused()) {
      latest.current.openPageRoute(held)
    }
  }, [isWideLayout])
  return (href, ownsHostArea) => {
    heldRef.current = ownsHostArea ? href : null
  }
}
