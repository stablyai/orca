import { z } from 'zod'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import type { RpcClient } from '../transport/rpc-client'
import type { ConversationRow } from './project-conversations'

const revealSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string(),
  workspaceId: z.string()
})

export async function conversationOpenPane(args: {
  row: ConversationRow
  client: RpcClient
  capabilities: readonly string[]
}): Promise<string | null> {
  if (args.row.paneKey) {
    return args.row.paneKey
  }
  const structured = args.row.history?.structuredSession
  if (!structured) {
    return null
  }
  if (!args.capabilities.includes(STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY)) {
    throw new Error('conversation_host_update_required')
  }
  const response = await args.client.sendRequest('agentSession.reveal', {
    sessionId: structured.sessionId
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = revealSchema.parse(response.result)
  if (
    result.sessionId !== structured.sessionId ||
    result.workspaceId !== (args.row.workspace?.worktreeId ?? structured.workspaceId)
  ) {
    throw new Error('conversation_host_identity_changed')
  }
  return structuredAgentSessionPaneKey(
    structuredAgentSessionTabId(result.sessionId),
    result.sessionId
  )
}
