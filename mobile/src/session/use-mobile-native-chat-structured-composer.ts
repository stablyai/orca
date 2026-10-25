import { useMemo } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatStructuredComposer } from './MobileNativeChatComposer'
import type { MobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

/** What a structured chat's composer adds: its session's `/` list, and files where the host
 *  stores them for phones. Null on a terminal-backed chat. */
export function useMobileNativeChatStructuredComposer(args: {
  client: RpcClient | null
  hostId: string | null
  sessionId: string | null
  structured: boolean
  connected: boolean
  /** The host keeps files a phone uploads; an older one refuses the upload. */
  acceptsFiles: boolean
  conversationCommands: readonly AgentSessionConversationCommand[] | undefined
  files: MobileNativeChatFileAttachments
}): MobileNativeChatStructuredComposer | null {
  const { client, hostId, sessionId, structured, connected, acceptsFiles, files } = args
  const conversationCommands = args.conversationCommands ?? NO_COMMANDS
  const { commands, refresh } = useMobileStructuredSessionCommands({
    client,
    hostId,
    sessionId,
    enabled: structured && connected
  })
  const { files: pendingFiles, attachFiles, removeFiles } = files
  // Its own memo: an attach or an upload landing leaves the `/` menu's catalog as it was.
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
            ...(acceptsFiles ? { onAttachFiles: () => void attachFiles() } : {}),
            files: pendingFiles,
            onRemoveFile: (id: string) => removeFiles([id])
          }
        : null,
    [acceptsFiles, attachFiles, catalog, pendingFiles, refresh, removeFiles, structured]
  )
}
