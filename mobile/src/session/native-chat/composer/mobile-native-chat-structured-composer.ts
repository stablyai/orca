import type { MobileComposerStructuredCatalog } from './mobile-native-chat-composer-menu'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import type { MobileStructuredThreadGoal } from '../input/use-mobile-structured-thread-goal'

/** Stored-file chips and the Files entry of a terminal-backed chat, which has no structured composer. */
export type MobileNativeChatTerminalFileAttachments = {
  files: readonly PendingNativeChatFile[]
  /** Absent when the host cannot store phone files: the + then opens photos directly. */
  onAttachFiles?: () => void
  onRemoveFile: (id: string) => void
}

export type MobileNativeChatStructuredComposer = {
  catalog: MobileComposerStructuredCatalog
  onSlashMenuOpen: () => void
  onSlashMenuDemand?: (open: boolean) => void
  onAttachFiles?: () => void
  /** Set when the host keeps phone files, so a long paste becomes a "Pasted text" file. */
  onAttachPastedText?: (text: string) => void
  // An uploading attachment must hold Send.
  files: readonly PendingNativeChatFile[]
  onRemoveFile: (id: string) => void
  /** Null unless the host reports goals for this chat. */
  threadGoal?: MobileStructuredThreadGoal | null
}
