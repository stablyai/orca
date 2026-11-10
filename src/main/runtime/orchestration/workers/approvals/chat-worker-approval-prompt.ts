/** A chat worker's permission prompt is its own journal item: Orca reads it there and answers it
 *  through the chat's ordinary prompt response, so the worker's chat and Orca share one record. */
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mintAgentSessionOperationId } from '../../mailbox/structured-pointer/structured-pointer-operation-id'
import { workerApprovalOption, type WorkerApprovalDecision } from './worker-approval'

/** Marks a prompt Orca answered for a coordinator or a person, so the chat's own closer leaves it alone. */
export const ORCHESTRATION_APPROVAL_CALLER_PREFIX = 'trusted-local:orchestration:approval:'

export type ChatWorkerPrompt = { revision: number; body: AgentJournalApprovalItem }
export type ChatWorkerPromptReader = (
  sessionId: string,
  itemId: string
) => Promise<ChatWorkerPrompt | null>

/** The approval item by its journal id, pending or settled; null for anything else or an unreadable chat. */
export const readChatWorkerPrompt: ChatWorkerPromptReader = async (sessionId, itemId) => {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const snapshot = await host.journalCurrentRead(sessionId)
    const item = snapshot.items.find((candidate) => candidate.itemId === itemId)
    return item?.body.kind === 'approval' ? { revision: item.revision, body: item.body } : null
  } catch {
    return null
  }
}

export type ChatWorkerApprovalAnswer =
  | { ok: true; prompt: ChatWorkerPrompt; optionLabel: string }
  | {
      ok: false
      code: 'approval_not_open' | 'approval_option_missing' | 'approval_refused'
      message: string
    }

/** Answer as Orca with the one option the decision may pick; the chat checks the revision it read. */
export async function answerChatWorkerApproval(input: {
  sessionId: string
  approvalId: string
  dispatchId: string
  decision: WorkerApprovalDecision
  readPrompt?: ChatWorkerPromptReader
}): Promise<ChatWorkerApprovalAnswer> {
  const { sessionId, approvalId, decision } = input
  const prompt = await (input.readPrompt ?? readChatWorkerPrompt)(sessionId, approvalId)
  const host = getStructuredAgentSessionHost()
  const fence = host?.deps.store.getConversation(sessionId)?.currentFence
  if (!prompt || prompt.body.resolution.state !== 'pending' || !host || fence === undefined) {
    return {
      ok: false,
      code: 'approval_not_open',
      message: `Approval ${approvalId} is no longer open; nothing was answered.`
    }
  }
  const option = workerApprovalOption(prompt.body.options, decision)
  if (!option) {
    return {
      ok: false,
      code: 'approval_option_missing',
      message:
        decision === 'deny'
          ? `Approval ${approvalId} offers no way to refuse just this request, so Orca will not pick one. A person must answer it on the worker.`
          : `Approval ${approvalId} offers no way to allow just this request. A person must answer it on the worker.`
    }
  }
  const fields = { itemId: approvalId, expectedRevision: prompt.revision, optionId: option.id }
  const result = await host.respondToPrompt(
    { callerKey: `${ORCHESTRATION_APPROVAL_CALLER_PREFIX}${input.dispatchId}` },
    {
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.respondTo:approval',
          sessionId,
          fields
        })
      },
      kind: 'approval',
      ...fields
    }
  )
  if (!result.ok) {
    return {
      ok: false,
      code: 'approval_refused',
      message: `The worker's chat did not take the answer to ${approvalId}: ${result.refusal.message}`
    }
  }
  return { ok: true, prompt, optionLabel: option.label }
}
