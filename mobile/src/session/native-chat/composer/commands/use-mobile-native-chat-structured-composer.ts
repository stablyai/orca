import { useMemo } from 'react'
import type { AgentSessionConversationCommand } from '../../../../../../src/shared/agent-session/agent-session-conversation-command'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'
import type { MobileNativeChatFileAttachments } from '../attachments/use-mobile-native-chat-file-attachments'
import type { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'
import type { MobileStructuredThreadGoal } from '../../input/tasks/use-mobile-structured-thread-goal'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

export function useMobileNativeChatStructuredComposer(args: {
  structured: boolean
  sessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
  /** The host keeps files a phone uploads; an older one refuses the upload. */
  acceptsFiles: boolean
  conversationCommands: readonly AgentSessionConversationCommand[] | undefined
  compactInstructions?: boolean | undefined
  files: MobileNativeChatFileAttachments
  threadGoal: MobileStructuredThreadGoal | null
}): MobileNativeChatStructuredComposer | null {
  const { structured, acceptsFiles, compactInstructions, files, threadGoal } = args
  const conversationCommands = args.conversationCommands ?? NO_COMMANDS
  const { commands, refresh, setMenuOpen } = args.sessionCommands
  const { files: pendingFiles, attachFiles, attachPastedText, removeFiles } = files
  // Memoize commands separately so attachment changes cannot rebuild the menu catalog.
  const catalog = useMemo(
    () => ({ reported: commands, conversationCommands, compactInstructions }),
    [commands, compactInstructions, conversationCommands]
  )
  return useMemo(
    () =>
      structured
        ? {
            catalog,
            onSlashMenuOpen: refresh,
            onSlashMenuDemand: setMenuOpen,
            onAttachFiles: acceptsFiles ? () => void attachFiles() : undefined,
            onAttachPastedText:
              acceptsFiles && attachPastedText
                ? (text: string) => void attachPastedText(text)
                : undefined,
            files: pendingFiles,
            onRemoveFile: (id: string) => removeFiles([id]),
            threadGoal
          }
        : null,
    [
      threadGoal,
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
