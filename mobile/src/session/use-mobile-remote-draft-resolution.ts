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
  clearUncertain,
  activeHandle,
  bumpOperationGeneration,
  setInput,
  input,
  release,
  showToast
}: {
  conflict: MobileRemoteDraftConflict | null
  sessionRef: { current: MobileRemoteDraftSession | null }
  setSession: (session: MobileRemoteDraftSession | null) => void
  setConflict: (conflict: MobileRemoteDraftConflict | null) => void
  clearUncertain: (handle: string) => void
  activeHandle: string | null
  bumpOperationGeneration: (handle: string) => void
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
    clearUncertain(current.handle)
    showToast('Loaded the terminal version', 1400)
  }, [clearUncertain, conflict, sessionRef, setConflict, setInput, setSession, showToast])

  const keepConflictMine = useCallback(() => {
    const current = sessionRef.current
    if (!current || !conflict) {
      return
    }
    setSession({ ...current, baseToken: conflict.sourceToken })
    setConflict(null)
    clearUncertain(current.handle)
    showToast('Saving will overwrite the terminal draft', 1800)
  }, [clearUncertain, conflict, sessionRef, setConflict, setSession, showToast])

  const exitRemoteDraft = useCallback(() => {
    const current = sessionRef.current
    const handle = current?.handle ?? activeHandle
    release(current)
    setSession(null)
    setConflict(null)
    if (handle) {
      clearUncertain(handle)
      bumpOperationGeneration(handle)
    }
    showToast('Stopped editing the terminal draft', 1400)
  }, [
    activeHandle,
    bumpOperationGeneration,
    clearUncertain,
    release,
    sessionRef,
    setConflict,
    setSession,
    showToast
  ])

  return { reloadConflict, keepConflictMine, exitRemoteDraft, input }
}
