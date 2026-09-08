import { useCallback, useRef, useState, type MutableRefObject } from 'react'

// In-place reloads must retire page authority even when the native view and session survive.
export function useMobileWebPageDocument({
  sessionId,
  viewEpoch
}: {
  sessionId: string | undefined
  viewEpoch: number
}): {
  epoch: number
  initializedSessionRef: MutableRefObject<string | undefined>
  readySessionId: string | undefined
  setReadySessionId: (sessionId: string | undefined) => void
  onLoadStart: () => void
  onLoaded: () => void
} {
  const initializedSessionRef = useRef<string | undefined>(undefined)
  const loadedRef = useRef(false)
  const [epoch, setEpoch] = useState(0)
  const [document, setDocument] = useState({
    view: '',
    readySessionId: undefined as string | undefined
  })

  const resetDocument = useCallback((view: string) => {
    initializedSessionRef.current = undefined
    loadedRef.current = false
    setDocument({ view, readySessionId: undefined })
  }, [])

  // Resetting during render rather than in an effect: an effect would let one paint show the
  // outgoing page's readiness against the incoming document.
  const view = `${sessionId ?? ''}:${viewEpoch}`
  if (document.view !== view) {
    resetDocument(view)
  }

  const onLoadStart = useCallback(() => {
    // Duplicate loading notifications do not represent another document.
    if (!loadedRef.current) {
      return
    }
    // Reset before loaded can arrive in the same batch, rather than in the epoch's effect.
    resetDocument(view)
    setEpoch((current) => current + 1)
  }, [resetDocument, view])

  const onLoaded = useCallback(() => {
    loadedRef.current = true
  }, [])

  const setReadySessionId = useCallback((ready: string | undefined) => {
    setDocument((current) => ({ ...current, readySessionId: ready }))
  }, [])

  return {
    epoch,
    initializedSessionRef,
    readySessionId: document.view === view ? document.readySessionId : undefined,
    setReadySessionId,
    onLoadStart,
    onLoaded
  }
}
