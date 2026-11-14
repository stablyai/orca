import type { MobileComposerStructuredCatalog } from '../menus/mobile-native-chat-composer-menu'
import type { PendingNativeChatFile } from '../attachments/mobile-native-chat-file-attachment'
import type { MobileStructuredThreadGoal } from '../../input/tasks/use-mobile-structured-thread-goal'

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
