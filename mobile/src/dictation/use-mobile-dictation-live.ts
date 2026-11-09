import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useHostDisplay } from '../transport/hosts/use-host-display'
import { useHostProfile } from '../transport/hosts/use-host-profile'
import type { MobileDictationLive } from './mobile-dictation-live-context'

// What every dictation control reads while one runs: meter, engine, the computer's name and cancel.
export function useMobileDictationLive(
  dictation: Pick<UseMobileDictationResult, 'meter' | 'engine'>,
  cancel: () => void,
  hostId: string
): MobileDictationLive {
  const cancelLatest = useRef(cancel)
  useLayoutEffect(() => {
    cancelLatest.current = cancel
  }, [cancel])
  const stableCancel = useCallback(() => cancelLatest.current(), [])
  const hostProfile = useHostProfile(hostId)
  const hostTitle = useHostDisplay(hostProfile).title
  // A workspace routed to another server transcribes there, and the phone lacks that server's name.
  const computerName = useWorkspaceExecutionHost() === undefined && hostProfile ? hostTitle : null
  const { meter, engine } = dictation
  return useMemo(
    () => ({ meter, engine, computerName, cancel: stableCancel }),
    [meter, engine, computerName, stableCancel]
  )
}
