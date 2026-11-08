import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect } from 'react'
import { useAppActive } from '../hooks/use-now'
import { setForegroundTimer } from './foreground-timer'
import { prewarmSpareShellDocument } from './spare-shell-document'

// Native drops the spare on background and memory pressure, so every arm restarts on a return to the
// foreground; the delay counts foreground time only.
function armRefill(
  hostId: string | null,
  active: boolean,
  delayMs: number,
  replace: boolean
): (() => void) | undefined {
  if (hostId === null || !active) {
    return undefined
  }
  return setForegroundTimer(() => {
    void prewarmSpareShellDocument(hostId, replace)
  }, delayMs)
}

// Boot the next spare `delayMs` after this host's page painted: the host just entered is the likeliest
// next entry, so its build replaces a parked spare of another.
export function useSpareShellDocumentRefill(
  hostId: string | null,
  armed: boolean,
  delayMs: number
): void {
  const active = useAppActive()
  useEffect(
    () => armRefill(armed ? hostId : null, active, delayMs, true),
    [active, armed, delayMs, hostId]
  )
}

// Boot a spare `delayMs` after the screen gains focus, unless one is already parked; a blur cancels it
// without a render. Keeping a parked spare stops Home and a screen trading builds on every return.
export function useSpareShellDocumentRefillOnFocus(hostId: string | null, delayMs: number): void {
  const active = useAppActive()
  useFocusEffect(
    useCallback(() => armRefill(hostId, active, delayMs, false), [active, delayMs, hostId])
  )
}
