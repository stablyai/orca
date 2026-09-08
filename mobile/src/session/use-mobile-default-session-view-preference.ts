import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SESSION_VIEW,
  readDefaultSessionViewPreference,
  saveDefaultSessionView,
  type MobileSessionView
} from '../storage/session-view-preferences'

export type MobileDefaultSessionViewPreference = {
  busy: boolean
  error: string | null
  defaultView: MobileSessionView
  setDefaultView: (view: MobileSessionView) => void
}

/** Owns the optimistic Settings value while keeping AsyncStorage writes ordered. */
export function useMobileDefaultSessionViewPreference(): MobileDefaultSessionViewPreference {
  const [defaultView, setDefaultViewState] = useState<MobileSessionView>(DEFAULT_SESSION_VIEW)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const mutationRevisionRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    const loadRevision = mutationRevisionRef.current
    let stale = false
    void readDefaultSessionViewPreference().then((preference) => {
      // Why: a fast toggle is authoritative over the older storage read.
      if (!stale && mutationRevisionRef.current === loadRevision) {
        setDefaultViewState(preference.value ?? DEFAULT_SESSION_VIEW)
        setBusy(!preference.loaded)
        if (!preference.loaded) {
          setError('Could not load chat preferences. Go back and try again.')
        }
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
    setBusy(true)
    setError(null)
    // Why: persistence owns a shared queue, so invoking it at event time preserves
    // mutation order even when this route unmounts and a new instance takes over.
    void saveDefaultSessionView(view)
      .catch(async () => {
        const persisted = await readDefaultSessionViewPreference()
        if (mountedRef.current && mutationRevisionRef.current === revision) {
          setDefaultViewState(persisted.value ?? DEFAULT_SESSION_VIEW)
          setError('Could not save chat preferences. Try again.')
        }
      })
      .finally(() => {
        if (mountedRef.current && mutationRevisionRef.current === revision) {
          setBusy(false)
        }
      })
  }, [])

  return { defaultView, setDefaultView, busy, error }
}
