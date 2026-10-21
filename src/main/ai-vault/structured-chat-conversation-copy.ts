import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentForksThroughChat } from '../../shared/agent-resume-argv'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { isAiVaultAgent } from './session-list-result-validation'
import { findResumeOwnership } from './structured-session-ownership'

/**
 * A fork of a chat's conversation, for an agent whose chat makes the copy: the chat's host copies
 * it and answers the copy, which the terminal resumes and no chat owns. Null for any other prepare.
 * Runs on the host that runs the chat, as every resume preparation does.
 */
export async function copyStructuredChatConversation(
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult | null> {
  if (!args.fork || !agentForksThroughChat(args.agent)) {
    return null
  }
  const host = getStructuredAgentSessionHost()
  const ownership = findResumeOwnership(args)
  const record = ownership ? host?.deps.store.getRecord(ownership.sessionId) : undefined
  const copy = host?.deps.adapter.copyConversation
  if (!host || !ownership || !record || !copy) {
    throw new Error('This chat is no longer in Orca, so it cannot be copied to a new CLI.')
  }
  return copyStructuredChatRecordConversation(record, ownership.providerSessionId)
}

export async function copyStructuredChatRecordConversation(
  record: AgentSessionRecord,
  providerSessionId: string
): Promise<AiVaultPrepareSessionResumeResult> {
  const host = getStructuredAgentSessionHost()
  const copy = host?.deps.adapter.copyConversation
  if (!host || !copy || !isAiVaultAgent(record.provider)) {
    throw new Error('This chat cannot be copied to a new CLI.')
  }
  const forkedSession = await copy.call(host.deps.adapter, {
    identity: {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      hostId: record.location.executionHostId,
      agent: record.provider,
      providerHandle:
        agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle ?? null
    },
    providerSessionId,
    accountHome: record.accountHome
  })
  if (
    !forkedSession.sessionId.trim() ||
    forkedSession.sessionId === providerSessionId ||
    findResumeOwnership({
      agent: record.provider,
      sessionId: forkedSession.sessionId,
      filePath: ''
    })
  ) {
    throw new Error('The agent returned a conversation already owned by a chat instead of a copy.')
  }
  return {
    useRealCodexHome: false,
    forkedSession: {
      ...forkedSession,
      // The chat's own agent, not the row's: an OpenCode 2 row's chat runs `opencode`.
      agent: record.provider
    }
  }
}
