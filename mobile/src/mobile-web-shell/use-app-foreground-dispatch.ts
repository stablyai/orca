import { useEffect, type RefObject } from 'react'
import { subscribeAppForeground } from '../transport/socket-deadline-clock'
import type { MobileWebShellSessionEvent } from './mobile-web-shell-session-contract'

// Report each return to the app; the reducer decides whether a link-lost download retries.
export function useAppForegroundDispatch(
  dispatch: (epoch: number, event: MobileWebShellSessionEvent) => void,
  epochRef: RefObject<number>
): void {
  useEffect(
    () => subscribeAppForeground(() => dispatch(epochRef.current, { type: 'app-foregrounded' })),
    [dispatch, epochRef]
  )
}
