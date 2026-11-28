import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionPromptRequest } from '../../native-chat/agent-session-wire/operations/structured-agent-session-turns-prompt'
import {
  AgentSessionRefusalError,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'
import { mapChatPrompt, parseChatPromptId } from '../../../shared/agent-prompt/pending-agent-prompt'
import type {
  AgentPromptRespondResult,
  PendingAgentPrompt
} from '../../../shared/rpc-contract/agent-prompt-params'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { LocatedAgentPrompt } from './located-agent-prompt'

type ChatPromptHost = Pick<
  StructuredAgentSessionHost,
  'loadedSessionIds' | 'publishedWork' | 'deps' | 'respondToPrompt'
>

export function agentPromptResultFromRefusal(
  code: AgentSessionWireRefusalCode
): AgentPromptRespondResult {
  if (
    code === 'agent_session_item_revision_stale' ||
    code === 'agent_session_already_resolved' ||
    code === 'agent_session_checkpoint_stale'
  ) {
    return { ok: false, reason: 'stale' }
  }
  if (code === 'agent_session_operation_unknown') {
    return { ok: false, reason: 'not_found' }
  }
  if (
    code === 'agent_session_operation_invalid' ||
    code === 'agent_session_operation_conflict' ||
    code === 'agent_session_conflict'
  ) {
    return { ok: false, reason: 'rejected' }
  }
  return { ok: false, reason: 'unavailable' }
}

export function chatPromptMutation(input: {
  sessionId: string
  itemId: string
  revision: number
  kind: 'approval' | 'question'
  optionId: string
  clientOperationId: string
}): { request: AgentSessionPromptRequest; envelope: AgentSessionMutationEnvelope } {
  const fields = {
    itemId: input.itemId,
    expectedRevision: input.revision,
    optionId: input.optionId,
    answers: undefined
  }
  return {
    request: {
      itemId: input.itemId,
      expectedRevision: input.revision,
      kind: input.kind,
      optionId: input.optionId
    },
    envelope: {
      sessionId: input.sessionId,
      clientOperationId: input.clientOperationId,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: `agentSession.respondTo:${input.kind}`,
        sessionId: input.sessionId,
        fields
      })
    }
  }
}

export function listChatPrompts(host: ChatPromptHost | null): LocatedAgentPrompt[] {
  if (!host) {
    return []
  }
  const located: LocatedAgentPrompt[] = []
  for (const sessionId of host.loadedSessionIds()) {
    let record: ReturnType<ChatPromptHost['deps']['store']['getConversation']>
    try {
      record = host.deps.store.getConversation(sessionId)
    } catch {
      continue
    }
    const worktreeId = record?.location.workspaceId
    if (!record || !worktreeId || !record.provider) {
      continue
    }
    const items = host.publishedWork(sessionId)?.actionablePrompts ?? []
    for (const item of items) {
      const prompt = mapChatPrompt({
        sessionId,
        worktreeId,
        agent: record.provider,
        item
      })
      if (!prompt) {
        continue
      }
      located.push({
        prompt,
        paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId),
        agent: record.provider
      })
    }
  }
  return located
}

export function chatTargetExists(sessionId: string): boolean {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return false
  }
  if (host.loadedSessionIds().includes(sessionId)) {
    return true
  }
  try {
    return host.deps.store.getConversation(sessionId) !== null
  } catch {
    return false
  }
}

export async function applyChatPrompt(
  prompt: PendingAgentPrompt,
  optionId: string,
  clientOperationId: string,
  callerKey: string
): Promise<AgentPromptRespondResult> {
  const parsed = parseChatPromptId(prompt.promptId)
  const host = getStructuredAgentSessionHost()
  if (!parsed || prompt.target.type !== 'chat' || !host) {
    return { ok: false, reason: 'unavailable' }
  }
  const mutation = chatPromptMutation({
    sessionId: parsed.sessionId,
    itemId: parsed.itemId,
    revision: parsed.revision,
    kind: prompt.kind === 'permission' ? 'approval' : 'question',
    optionId,
    clientOperationId
  })
  try {
    const result = await host.respondToPrompt(
      { callerKey },
      { ...mutation.request, envelope: mutation.envelope }
    )
    return result.ok ? { ok: true } : agentPromptResultFromRefusal(result.refusal.code)
  } catch (error) {
    if (error instanceof AgentSessionRefusalError) {
      return agentPromptResultFromRefusal(error.refusal.code)
    }
    return { ok: false, reason: 'unavailable' }
  }
}
