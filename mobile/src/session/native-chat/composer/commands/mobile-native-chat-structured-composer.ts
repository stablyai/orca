import type { MobileComposerStructuredCatalog } from '../menus/mobile-native-chat-composer-menu'
import type { PendingNativeChatFile } from '../attachments/mobile-native-chat-file-attachment'
import type { MobileStructuredThreadGoal } from '../../input/tasks/use-mobile-structured-thread-goal'
import type { MobileStructuredMcpPanel } from '../../mcp/use-mobile-structured-mcp-panel'
import type { MobileStructuredAccountUsage } from '../../usage/use-mobile-structured-account-usage'

export type MobileNativeChatStructuredComposer = {
  catalog: MobileComposerStructuredCatalog
  catchingUp?: boolean
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
  /** Null unless the host manages this agent's MCP servers; `/mcp` opens it. */
  mcpPanel?: MobileStructuredMcpPanel | null
  /** Null unless the host shows this chat's account usage; `/usage` opens it. */
  accountUsage?: MobileStructuredAccountUsage | null
  /** Why an Orca command (`/fork`, `/resume`) did not run, shown beside the composer. */
  onCommandNotice?: (message: string) => void
}
