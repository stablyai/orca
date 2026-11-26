import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'
import type { useMobileNativeChatController } from './native-chat/use-mobile-native-chat-controller'

// The fields a screen's dictation reads; a group room has no terminal, so its terminal fields stay empty.
export type MobileScreenDictationScope = Pick<
  MobileSessionFeedbackCapabilitiesModel,
  | 'hostId'
  | 'worktreeId'
  | 'client'
  | 'connState'
  | 'activeHandle'
  | 'activeHandleRef'
  | 'setShowDictationSetup'
  | 'dictationRouteContextRef'
  | 'flushPendingLiveInputBeforeExternalSend'
  | 'canSend'
  | 'showToast'
  | 'router'
  | 'dictationMode'
  | 'setDictationMode'
  | 'setDictationEnabled'
>

// The screen the dictation belongs to: the key its copies share, its stack route, and the title and link the pill reopens.
export type MobileDictationScreenRoute = {
  readonly key: string
  readonly name: string
  readonly title: string
  readonly paneKey: string | undefined
  readonly href: string
}

export type MobileDictationChat = Pick<
  ReturnType<typeof useMobileNativeChatController>,
  'showNativeChat' | 'showNativeChatRef' | 'chatComposerScopeKey' | 'setChatComposerText'
>
