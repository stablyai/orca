import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useHostDisplay } from '../transport/hosts/use-host-display'
import { useHostProfile } from '../transport/hosts/use-host-profile'
import type { MobileDictationLive } from './mobile-dictation-live-context'
import { dictationFailureReason } from './mobile-dictation-controls-copy'

// What every dictation control reads while one runs or waits for Retry: meter, engine, the computer's name, cancel and Retry.
export function useMobileDictationLive(
  dictation: Pick<UseMobileDictationResult, 'meter' | 'engine' | 'failure' | 'retry'>,
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
  const { meter, engine, failure, retry } = dictation
  const failureReason = failure === null ? null : dictationFailureReason(failure)
  return useMemo(
    () => ({
      meter,
      engine,
      computerName,
      cancel: stableCancel,
      failureReason,
      retry: () => void retry()
    }),
    [meter, engine, computerName, stableCancel, failureReason, retry]
  )
}
