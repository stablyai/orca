import { unlink } from 'node:fs/promises'
import type { AgentSessionAuxiliaryChat } from '../../../../shared/agent-session/lifecycle/records/agent-session-auxiliary-chat'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'

export function auxiliaryChatChildren(
  host: StructuredAgentSessionHost,
  parentSessionId: string
): AgentSessionConversationView[] {
  return host.deps.store
    .listConversations()
    .filter((record) => record.auxiliaryChat?.parentSessionId === parentSessionId)
}

/** A derived file is disposable only once no child process can still write it. */
export async function discardAuxiliaryChatFile(
  auxiliary: AgentSessionAuxiliaryChat
): Promise<void> {
  await unlink(auxiliary.nativeFilePath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  })
}
