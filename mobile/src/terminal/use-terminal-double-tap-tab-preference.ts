import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadTerminalDoubleTapTabEnabled,
  saveTerminalDoubleTapTabEnabled
} from '../storage/preferences'

export type TerminalDoubleTapTabPreference = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export function useTerminalDoubleTapTabPreference(): TerminalDoubleTapTabPreference {
  const [enabled, setEnabledState] = useState(false)
  const mountedRef = useRef(false)
  const mutationRevisionRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    const loadRevision = mutationRevisionRef.current
    let stale = false
    void loadTerminalDoubleTapTabEnabled().then((stored) => {
      if (!stale && mutationRevisionRef.current === loadRevision) {
        setEnabledState(stored)
      }
    })
    return () => {
      stale = true
      mountedRef.current = false
    }
  }, [])

  const setEnabled = useCallback((next: boolean) => {
    const revision = mutationRevisionRef.current + 1
    mutationRevisionRef.current = revision
    setEnabledState(next)
    void saveTerminalDoubleTapTabEnabled(next).catch(async () => {
      const stored = await loadTerminalDoubleTapTabEnabled()
      if (mountedRef.current && mutationRevisionRef.current === revision) {
        setEnabledState(stored)
      }
    })
  }, [])

  return { enabled, setEnabled }
}
