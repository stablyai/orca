import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import { useHostProfile } from '../host-catalog/use-host-profile'
import type { MobileDictationLive } from './mobile-dictation-live-context'
import type { MobileDictationAutoSend } from './mobile-dictation-auto-send'
import { dictationFailureReason } from './mobile-dictation-controls-copy'

// What every dictation control reads while one runs or waits for Retry: meter, engine, the computer's name, cancel, Retry and auto-send.
export function useMobileDictationLive(
  dictation: Pick<UseMobileDictationResult, 'meter' | 'engine' | 'failure' | 'retry'>,
  cancel: () => void,
  hostId: string,
  autoSend: MobileDictationAutoSend
): MobileDictationLive {
  const cancelLatest = useRef(cancel)
  useLayoutEffect(() => {
    cancelLatest.current = cancel
  }, [cancel])
  const stableCancel = useCallback(() => cancelLatest.current(), [])
  const computerName = useDictationComputerName(hostId)
  const { meter, engine, failure, retry } = dictation
  const failureReason = failure === null ? null : dictationFailureReason(failure)
  return useMemo(
    () => ({
      meter,
      engine,
      computerName,
      cancel: stableCancel,
      failureReason,
      retry: () => void retry(),
      autoSend
    }),
    [meter, engine, computerName, stableCancel, failureReason, retry, autoSend]
  )
}

// The computer that transcribes a session's dictation; null when another server runs the workspace and the phone lacks its name.
export function useDictationComputerName(hostId: string): string | null {
  const hostProfile = useHostProfile(hostId)
  const hostTitle = useHostDisplay(hostProfile).title
  return useWorkspaceExecutionHost() === undefined && hostProfile ? hostTitle : null
}
