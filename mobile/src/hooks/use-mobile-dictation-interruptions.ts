import { useEffect, type RefObject } from 'react'
import { AppState } from 'react-native'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import type { DictationCapture } from '../platform/dictation-capture-contract'
import type { MobileDictationAudioPhase } from './mobile-dictation-audio-chunk'
import type { DictationStatus } from './mobile-dictation-session-state'

// Calls, Siri, mic dropouts and leaving the app finish what was already heard; only the user's own cancel may discard it.
export function useMobileDictationInterruptions({
  capture,
  status,
  audioPhase,
  stopWhenStarted,
  cutShort,
  applyStatus,
  finish,
  abandon
}: {
  capture: DictationCapture
  status: RefObject<DictationStatus>
  audioPhase: RefObject<MobileDictationAudioPhase>
  stopWhenStarted: RefObject<boolean>
  cutShort: RefObject<boolean>
  applyStatus: (next: DictationStatus) => void
  finish: (emptyTranscriptMessage: string) => Promise<void>
  abandon: (reason: string | null) => Promise<void>
}): void {
  useEffect(() => {
    const interrupted = () => {
      if (status.current === 'recording') {
        cutShort.current = true
        void finish(dictationSessionErrorMessage('interrupted'))
      } else if (audioPhase.current === 'holding') {
        // The mic is live while the host start is pending: close it now, and finish with what it heard once the start commits.
        cutShort.current = true
        stopWhenStarted.current = true
        applyStatus('processing')
        void capture.end()
      } else if (status.current === 'starting') {
        void abandon(dictationSessionErrorMessage('interrupted'))
      }
    }
    const sub = capture.onInterruption(interrupted)
    // A backgrounded app loses the microphone, so leaving finishes. Not before the mic opens: Android's permission prompt reports background.
    const appState = AppState.addEventListener('change', (state) => {
      if (
        state === 'background' &&
        (status.current === 'recording' || audioPhase.current === 'holding')
      ) {
        interrupted()
      }
    })
    return () => {
      sub.remove()
      appState.remove()
    }
  }, [abandon, applyStatus, audioPhase, capture, cutShort, finish, status, stopWhenStarted])
}
