import type { UseMobileDictationResult } from '../hooks/use-mobile-dictation'

/** What the native chat mic shows: `salvaging` is a failed stream's finish still in its grace period. */
export type MobileDictationPhase = 'idle' | 'starting' | 'recording' | 'processing' | 'salvaging'

export type NativeChatDictationToggleAction = 'start' | 'stop' | 'cancel' | 'ignore'

export function nativeChatDictationPhase(
  dictation: Pick<UseMobileDictationResult, 'status' | 'failedStreamFinish'>
): MobileDictationPhase {
  switch (dictation.status) {
    case 'starting':
    case 'recording':
      return dictation.status
    case 'processing':
      // Why: past the grace period a salvage is just a slow upload, so a tap may cancel it like one.
      return dictation.failedStreamFinish === 'grace' ? 'salvaging' : 'processing'
    default:
      return 'idle'
  }
}

/** Toggle mode: one tap starts, the next stops; a tap while processing cancels the upload. */
export function nativeChatDictationToggleAction(
  phase: MobileDictationPhase
): NativeChatDictationToggleAction {
  switch (phase) {
    case 'idle':
      return 'start'
    case 'recording':
      return 'stop'
    case 'processing':
      return 'cancel'
    default:
      // Why: a start still settling, or a failed stream finishing to keep its text, owns the tap.
      return 'ignore'
  }
}
