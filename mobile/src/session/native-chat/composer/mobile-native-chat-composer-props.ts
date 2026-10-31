import type { TextInput } from 'react-native'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat-follow-up-behavior'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileComposerStructuredCatalog } from './mobile-native-chat-composer-menu'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import type { MobileNativeChatSessionOptionPickersProps } from '../input/MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatMicProps } from './MobileNativeChatComposerMic'

export type MobileNativeChatStructuredComposer = {
  catalog: MobileComposerStructuredCatalog
  onSlashMenuOpen: () => void
  onSlashMenuDemand?: (open: boolean) => void
  onAttachFiles?: () => void
  // An uploading attachment must hold Send.
  files: readonly PendingNativeChatFile[]
  onRemoveFile: (id: string) => void
}

export type Props = MobileNativeChatMicProps & {
  // Applies dictation's edit to the draft this composer shows; false when it can no longer take it.
  insertDictation?: (insert: (draft: string) => string) => boolean | void
  draftScopeKey?: string | null
  editSession?: { cancel: () => void; refuseCommand: (text: string) => boolean; locked: boolean }
  onPickSkill?: (skill: { name: string; path: string }) => void
  inputRef?: React.RefObject<TextInput | null>
  // Terminal-backed chats keep curated commands and image-only attachment actions.
  structured?: MobileNativeChatStructuredComposer | null
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
  /** While the agent works on a host that queues: what a tap on Send does and whether holding it offers the other way; null otherwise. */
  sendFollowUp?: NativeChatSendFollowUp | null
  /** Changes whenever the route focuses a different chat composer surface. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation without forcing a screen render. */
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
  agent?: string | null
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  onAttachImage?: () => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  setupAgentStartHeld?: boolean
  setupInputHeld?: boolean
  disabled?: boolean
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

/** What a chat's composer sends through, which the chat view hands down from its route. */
export type MobileNativeChatSendProps = Pick<Props, 'onSend' | 'sendFollowUp'>
