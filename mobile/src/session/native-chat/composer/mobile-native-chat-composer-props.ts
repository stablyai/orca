import type { RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import type { NativeChatContextUsageSummary } from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import type { MobileNativeChatSessionOptionPickersProps } from '../input/MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSteerHead } from './use-mobile-native-chat-composer-tray'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobilePastedImages } from './mobile-native-chat-composer-paste'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import type { MobileNativeChatMicProps } from './MobileNativeChatComposerMic'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'

export type MobileNativeChatComposerProps = MobileNativeChatMicProps & {
  // Applies dictation's edit to the draft this composer shows; false when it can no longer take it.
  insertDictation?: (insert: (draft: string) => string) => boolean | void
  draftScopeKey?: string | null
  editSession?: {
    cancel: () => void
    refuseCommand: (text: string) => boolean
    locked: boolean
    interactionModeSupported?: boolean
  }
  onPickSkill?: (skill: { name: string; path: string }) => void
  inputRef?: RefObject<TextInput | null>
  // Terminal-backed chats keep curated commands and image-only attachment actions.
  structured?: MobileNativeChatStructuredComposer | null
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
  /** While the agent works on a host that queues: what a tap on Send does and whether holding it offers the other way; null otherwise. */
  sendFollowUp?: NativeChatSendFollowUp | null
  /** Cmd/Ctrl+Enter on an empty composer: steers the head queued card, or with no turn running sends it. */
  steerHead?: MobileNativeChatSteerHead
  /** Changes whenever the route focuses a different chat composer surface. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation without forcing a screen render. */
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
  agent?: string | null
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  /** A structured chat's context-window readout; null hides the ring. */
  contextUsage?: NativeChatContextUsageSummary | null
  onAttachImage?: () => void
  /** Images pasted into the field attach like a Photos pick. */
  onPasteImages?: (paste: MobilePastedImages) => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  disabled?: boolean
  /** The desktop is out: typing and Send (which queues) still work; attaching and dictation can't. */
  offline?: boolean
  /** Only Send is unavailable; typing, dictation and attachments still edit the draft. */
  sendDisabled?: boolean
  placeholder?: string
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  /** The host's disk-scanned skills, loaded once a skill trigger opens. */
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  /** Set while the agent can be stopped; Stop takes Send's slot when Send can't deliver. */
  stop?: { onStop?: () => void; held: boolean } | null
}
