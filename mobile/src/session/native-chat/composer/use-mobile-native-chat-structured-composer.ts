import { useMemo } from 'react'
import type { AgentSessionConversationCommand } from '../../../../../src/shared/agent-session/agent-session-conversation-command'
import type { MobileNativeChatStructuredComposer } from './MobileNativeChatComposer'
import type { MobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'
import type { useMobileStructuredSessionCommands } from '../../use-mobile-structured-session-commands'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

export function useMobileNativeChatStructuredComposer(args: {
  structured: boolean
  sessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
  /** The host keeps files a phone uploads; an older one refuses the upload. */
  acceptsFiles: boolean
  conversationCommands: readonly AgentSessionConversationCommand[] | undefined
  files: MobileNativeChatFileAttachments
}): MobileNativeChatStructuredComposer | null {
  const { structured, acceptsFiles, files } = args
  const conversationCommands = args.conversationCommands ?? NO_COMMANDS
  const { commands, refresh, setMenuOpen } = args.sessionCommands
  const { files: pendingFiles, attachFiles, removeFiles } = files
  // Memoize commands separately so attachment changes cannot rebuild the menu catalog.
  const catalog = useMemo(
    () => ({ reported: commands, conversationCommands }),
    [commands, conversationCommands]
  )
  return useMemo(
    () =>
      structured
        ? {
            catalog,
            onSlashMenuOpen: refresh,
            onSlashMenuDemand: setMenuOpen,
            ...(acceptsFiles ? { onAttachFiles: () => void attachFiles() } : {}),
            files: pendingFiles,
            onRemoveFile: (id: string) => removeFiles([id])
          }
        : null,
    [
      acceptsFiles,
      attachFiles,
      catalog,
      pendingFiles,
      refresh,
      removeFiles,
      setMenuOpen,
      structured
    ]
  )
}
