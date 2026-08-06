import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SESSION_VIEW,
  loadDefaultSessionView,
  saveDefaultSessionView,
  type MobileSessionView
} from '../storage/session-view-preferences'

export type MobileDefaultSessionViewPreference = {
  defaultView: MobileSessionView
  setDefaultView: (view: MobileSessionView) => void
}

/** Owns the optimistic Settings value while keeping AsyncStorage writes ordered. */
export function useMobileDefaultSessionViewPreference(): MobileDefaultSessionViewPreference {
  const [defaultView, setDefaultViewState] = useState<MobileSessionView>(DEFAULT_SESSION_VIEW)
  const mountedRef = useRef(false)
  const mutationRevisionRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    const loadRevision = mutationRevisionRef.current
    let stale = false
    void loadDefaultSessionView().then((view) => {
      // Why: a fast toggle is authoritative over the older storage read.
      if (!stale && mutationRevisionRef.current === loadRevision) {
        setDefaultViewState(view)
      }
    })
    return () => {
      stale = true
      mountedRef.current = false
    }
  }, [])

  const setDefaultView = useCallback((view: MobileSessionView) => {
    const revision = mutationRevisionRef.current + 1
    mutationRevisionRef.current = revision
    setDefaultViewState(view)
    // Why: persistence owns a shared queue, so invoking it at event time preserves
    // mutation order even when this route unmounts and a new instance takes over.
    void saveDefaultSessionView(view).catch(async () => {
      const persisted = await loadDefaultSessionView()
      if (mountedRef.current && mutationRevisionRef.current === revision) {
        setDefaultViewState(persisted)
      }
    })
  }, [])

  return { defaultView, setDefaultView }
}
