/** A chat worker's permission prompt is its own journal item: Orca reads it there and answers it
 *  through the chat's ordinary prompt response, so the worker's chat and Orca share one record. */
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mintAgentSessionOperationId } from '../../mailbox/structured-pointer/structured-pointer-operation-id'
import { workerApprovalDecisionOf, workerApprovalOption } from './worker-approval'
import type {
  WorkerApprovalDecision,
  WorkerApprovalOutcome
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

/** Marks a prompt Orca answered for a coordinator or a person, so the chat's own closer leaves it alone. */
export const ORCHESTRATION_APPROVAL_CALLER_PREFIX = 'trusted-local:orchestration:approval:'

export type ChatWorkerPrompt = { revision: number; body: AgentJournalApprovalItem }
export type ChatWorkerPromptReader = (
  sessionId: string,
  itemId: string
) => Promise<ChatWorkerPrompt | null>

/** The approval item by its journal id, pending or settled; null when the chat has no such item.
 *  Throws when the chat cannot be read, which proves nothing about the prompt. */
export const readChatWorkerPrompt: ChatWorkerPromptReader = async (sessionId, itemId) => {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('No chat host is running.')
  }
  const snapshot = await host.journalCurrentRead(sessionId)
  const item = snapshot.items.find((candidate) => candidate.itemId === itemId)
  return item?.body.kind === 'approval' ? { revision: item.revision, body: item.body } : null
}

/** How a reported chat approval closed, from its journal item; null while it is still open, or when
 *  Orca answered it, since that answer writes its own closing line with the reason. */
export function chatApprovalCloseOutcome(
  prompt: ChatWorkerPrompt | null
): WorkerApprovalOutcome | null {
  const resolution = prompt?.body.resolution
  if (
    resolution?.state === 'pending' ||
    resolution?.resolvedBy?.startsWith(ORCHESTRATION_APPROVAL_CALLER_PREFIX)
  ) {
    return null
  }
  return {
    by: resolution?.state === 'resolved' ? 'worker-chat' : 'unknown',
    decision: prompt ? workerApprovalDecisionOf(prompt.body) : null,
    reason: null,
    reasonDelivered: false
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
  const read = input.readPrompt ?? readChatWorkerPrompt
  const prompt = await read(sessionId, approvalId).catch(() => undefined)
  if (prompt === undefined) {
    return {
      ok: false,
      code: 'approval_refused',
      message: `Orca could not read the worker's chat, so ${approvalId} was not answered. Try again.`
    }
  }
  const notOpen: ChatWorkerApprovalAnswer = {
    ok: false,
    code: 'approval_not_open',
    message: `Approval ${approvalId} is no longer open; nothing was answered.`
  }
  if (!prompt) {
    return notOpen
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
  const callerKey = `${ORCHESTRATION_APPROVAL_CALLER_PREFIX}${input.dispatchId}`
  const { resolution } = prompt.body
  // A retry of this Dispatch's own answer: the same receipt, and no second effect.
  if (
    resolution.state === 'resolved' &&
    resolution.resolvedBy === callerKey &&
    resolution.selectedOptionId === option.id
  ) {
    return { ok: true, prompt, optionLabel: option.label }
  }
  const host = getStructuredAgentSessionHost()
  const fence = host?.deps.store.getConversation(sessionId)?.currentFence
  if (resolution.state !== 'pending' || !host || fence === undefined) {
    return notOpen
  }
  const fields = { itemId: approvalId, expectedRevision: prompt.revision, optionId: option.id }
  const result = await host.respondToPrompt(
    { callerKey },
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
    // Answered meanwhile, in the worker's chat or by another call: not this call's refusal.
    const now = await read(sessionId, approvalId).catch(() => null)
    return now && now.body.resolution.state !== 'pending'
      ? notOpen
      : {
          ok: false,
          code: 'approval_refused',
          message: `The worker's chat did not take the answer to ${approvalId}: ${result.refusal.message}`
        }
  }
  // A same-option answer already on record also succeeds; it is this call's only if Orca recorded it here.
  if (result.value.resolution.resolvedBy !== callerKey) {
    return notOpen
  }
  return { ok: true, prompt, optionLabel: option.label }
}
