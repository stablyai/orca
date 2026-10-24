import { useCallback } from 'react'
import type {
  MobileRemoteDraftConflict,
  MobileRemoteDraftSession
} from './use-mobile-session-remote-draft'

export function useMobileRemoteDraftResolution({
  conflict,
  sessionRef,
  setSession,
  setConflict,
  setUncertain,
  setInput,
  input,
  release,
  showToast
}: {
  conflict: MobileRemoteDraftConflict | null
  sessionRef: { current: MobileRemoteDraftSession | null }
  setSession: (session: MobileRemoteDraftSession | null) => void
  setConflict: (conflict: MobileRemoteDraftConflict | null) => void
  setUncertain: (uncertain: boolean) => void
  setInput: (value: string) => void
  input: string
  release: (session: MobileRemoteDraftSession | null) => void
  showToast: (message: string, duration?: number) => void
}) {
  const reloadConflict = useCallback(() => {
    const current = sessionRef.current
    if (!current || !conflict) {
      return
    }
    setInput(conflict.text)
    setSession({ ...current, baseToken: conflict.sourceToken, remoteText: conflict.text })
    setConflict(null)
    setUncertain(false)
    showToast('Loaded the terminal version', 1400)
  }, [conflict, sessionRef, setConflict, setInput, setSession, setUncertain, showToast])

  const keepConflictMine = useCallback(() => {
    const current = sessionRef.current
    if (!current || !conflict) {
      return
    }
    setSession({ ...current, baseToken: conflict.sourceToken })
    setConflict(null)
    setUncertain(false)
    showToast('Saving will overwrite the terminal draft', 1800)
  }, [conflict, sessionRef, setConflict, setSession, setUncertain, showToast])

  const exitRemoteDraft = useCallback(() => {
    release(sessionRef.current)
    setSession(null)
    setConflict(null)
    setUncertain(false)
    showToast('Stopped editing the terminal draft', 1400)
  }, [release, sessionRef, setConflict, setSession, setUncertain, showToast])

  return { reloadConflict, keepConflictMine, exitRemoteDraft, input }
}
