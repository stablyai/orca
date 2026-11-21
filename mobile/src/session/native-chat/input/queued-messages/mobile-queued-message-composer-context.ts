import type { NativeChatSkillDiscoverySnapshot } from '../../../../../../src/shared/native-chat/input/composer/native-chat-picker-items'
import { createContext, useMemo } from 'react'
import type { MobileNativeChatStructuredComposer } from '../../composer/commands/mobile-native-chat-structured-composer'
import type { MobileNativeChatController } from '../../mobile-native-chat-controller-contract'

type MobileQueuedMessageComposer = {
  agent: string | null
  interactionModeSupported?: boolean
  structured: MobileNativeChatStructuredComposer | null
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  filePaths: string[]
  onNeedFiles: ((query: string) => void) | undefined
  onError: (text: string) => void
  onMicPress: (() => void) | undefined
  micActive: boolean
  micStarting: boolean
  micProcessing: boolean
  dictationMode: string | undefined
  onMicPressIn: () => void
  onMicPressOut: () => void
}

export const MobileQueuedMessageComposerContext = createContext<MobileQueuedMessageComposer | null>(
  null
)

/** What a queued message's editor shares with the chat composer: its agent, pickers and mic. */
export function useMobileQueuedMessageComposer(
  controller: MobileNativeChatController,
  composer: Pick<
    MobileQueuedMessageComposer,
    | 'agent'
    | 'structured'
    | 'onMicPress'
    | 'micActive'
    | 'micStarting'
    | 'micProcessing'
    | 'dictationMode'
    | 'onMicPressIn'
    | 'onMicPressOut'
  >
): MobileQueuedMessageComposer {
  const { agent, structured, onMicPress, micActive, micStarting, micProcessing } = composer
  const { dictationMode, onMicPressIn, onMicPressOut } = composer
  const {
    nativeChatSessionOptions,
    nativeChatSkills,
    loadNativeChatSkills,
    nativeChatFilePaths,
    loadNativeChatFiles,
    reportQueuedEditError
  } = controller
  return useMemo(
    () => ({
      agent,
      structured,
      interactionModeSupported: nativeChatSessionOptions?.controller.snapshot.some(
        (entry) => entry.id === 'interactionMode'
      ),
      skillDiscovery: nativeChatSkills,
      onNeedSkills: loadNativeChatSkills,
      filePaths: nativeChatFilePaths,
      onNeedFiles: loadNativeChatFiles,
      onError: (message: string) => reportQueuedEditError?.(message),
      onMicPress,
      micActive,
      micStarting,
      micProcessing,
      dictationMode,
      onMicPressIn,
      onMicPressOut
    }),
    [
      agent,
      structured,
      nativeChatSessionOptions,
      nativeChatSkills,
      loadNativeChatSkills,
      nativeChatFilePaths,
      loadNativeChatFiles,
      reportQueuedEditError,
      onMicPress,
      micActive,
      micStarting,
      micProcessing,
      dictationMode,
      onMicPressIn,
      onMicPressOut
    ]
  )
}
