import { useMemo } from 'react'
import type { AgentSessionConversationCommand } from '../../../../../../src/shared/agent-session/conversation-context/agent-session-conversation-command'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'
import type { MobileNativeChatFileAttachments } from '../attachments/use-mobile-native-chat-file-attachments'
import type { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'
import type { MobileStructuredThreadGoal } from '../../input/tasks/use-mobile-structured-thread-goal'
import type { MobileStructuredMcpPanel } from '../../mcp/use-mobile-structured-mcp-panel'
import type { MobileStructuredAccountUsage } from '../../usage/use-mobile-structured-account-usage'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

export function useMobileNativeChatStructuredComposer(args: {
  structured: boolean
  catchingUp?: boolean
  sessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
  /** The host keeps files a phone uploads; an older one refuses the upload. */
  acceptsFiles: boolean
  conversationCommands: readonly AgentSessionConversationCommand[] | undefined
  compactInstructions?: boolean | undefined
  files: MobileNativeChatFileAttachments
  threadGoal: MobileStructuredThreadGoal | null
  mcpPanel: MobileStructuredMcpPanel | null
  accountUsage: MobileStructuredAccountUsage | null
  onCommandNotice: (message: string) => void
}): MobileNativeChatStructuredComposer | null {
  const { structured, acceptsFiles, compactInstructions, files, threadGoal, mcpPanel } = args
  const { accountUsage, onCommandNotice, catchingUp = false } = args
  const conversationCommands = args.conversationCommands ?? NO_COMMANDS
  const { commands, refresh, setMenuOpen } = args.sessionCommands
  const { files: pendingFiles, attachFiles, attachPastedText, removeFiles } = files
  // Memoize commands separately so attachment changes cannot rebuild the menu catalog.
  const offersMcpPanel = mcpPanel !== null
  const catalog = useMemo(
    () => ({
      reported: commands,
      conversationCommands,
      compactInstructions,
      mcpPanel: offersMcpPanel
    }),
    [commands, compactInstructions, conversationCommands, offersMcpPanel]
  )
  return useMemo(
    () =>
      structured
        ? {
            catalog,
            catchingUp,
            onSlashMenuOpen: refresh,
            onSlashMenuDemand: setMenuOpen,
            onAttachFiles: acceptsFiles ? () => void attachFiles() : undefined,
            onAttachPastedText:
              acceptsFiles && attachPastedText
                ? (text: string) => void attachPastedText(text)
                : undefined,
            files: pendingFiles,
            onRemoveFile: (id: string) => removeFiles([id]),
            threadGoal,
            mcpPanel,
            accountUsage,
            onCommandNotice
          }
        : null,
    [
      catchingUp,
      threadGoal,
      mcpPanel,
      accountUsage,
      onCommandNotice,
      acceptsFiles,
      attachFiles,
      attachPastedText,
      catalog,
      pendingFiles,
      refresh,
      removeFiles,
      setMenuOpen,
      structured
    ]
  )
}
