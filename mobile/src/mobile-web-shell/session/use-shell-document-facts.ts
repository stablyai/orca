import { useCallback, useState } from 'react'
import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

/** Page-ready and document-loaded live beside session state, so React has to store them to rerender. */
export function useShellDocumentFacts(session: MobileWebShellSession): {
  pageReady: boolean
  documentLoaded: boolean
  projectFacts: (session: MobileWebShellSession) => void
} {
  const [pageReady, setPageReady] = useState(session.pageReady)
  const [documentLoaded, setDocumentLoaded] = useState(session.documentLoaded)
  const projectFacts = useCallback((next: MobileWebShellSession) => {
    setPageReady(next.pageReady)
    setDocumentLoaded(next.documentLoaded)
  }, [])
  return { pageReady, documentLoaded, projectFacts }
}
