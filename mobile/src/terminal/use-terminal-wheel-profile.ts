import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TuiWheelProfile } from './document/tui-wheel-pacing'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

/**
 * Keeps the document's wheel profile in step with the pane's program. A fresh document moves one
 * row per wheel report, so readiness only has to name a different profile, and a change while the
 * document is not ready waits for that readiness instead of queueing behind it.
 *
 * Returns what readiness calls to tell the new document.
 */
export function useTerminalWheelProfile(
  profile: TuiWheelProfile,
  isWebReadyRef: RefObject<boolean>,
  sendToDocument: (msg: TerminalWebViewCommand) => number
) {
  const sentRef = useRef<TuiWheelProfile>('one-row')

  useEffect(() => {
    if (isWebReadyRef.current && profile !== sentRef.current) {
      sendToDocument({ type: 'set-tui-wheel-profile', profile })
      sentRef.current = profile
    }
  }, [isWebReadyRef, profile, sendToDocument])

  return useCallback(() => {
    sentRef.current = 'one-row'
    if (profile !== 'one-row') {
      sendToDocument({ type: 'set-tui-wheel-profile', profile })
      sentRef.current = profile
    }
  }, [profile, sendToDocument])
}
