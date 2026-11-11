import type { MobileComposerStructuredCatalog } from './mobile-native-chat-composer-menu'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import type { MobileStructuredThreadGoal } from '../input/use-mobile-structured-thread-goal'
import type { AgentSessionMcpRequest } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp'

export type MobileNativeChatStructuredComposer = {
  mcp?: { sessionKey: string; request: AgentSessionMcpRequest }
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
