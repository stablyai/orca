import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

/** What a chat's dictation reads of the screen it runs on: the session screen, or a page with one chat. */
export type MobileSessionDictationScope = Pick<
  MobileSessionFeedbackCapabilitiesModel,
  | 'hostId'
  | 'worktreeId'
  | 'client'
  | 'connState'
  | 'activeHandle'
  | 'activeHandleRef'
  | 'activeSessionTab'
  | 'setShowDictationSetup'
  | 'dictationRouteContextRef'
  | 'flushPendingLiveInputBeforeExternalSend'
  | 'canSend'
  | 'showToast'
  | 'router'
  | 'dictationMode'
  | 'setDictationMode'
  | 'setDictationEnabled'
> & {
  /** Where its pill returns to; the session's route when absent. */
  dictationHref?: string
}
