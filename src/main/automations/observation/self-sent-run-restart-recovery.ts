// A run that sends its own prompt, after Orca quit inside its dispatch: its chat is found by the
// prompt's run-derived id, as a launch receipt finds any other run's, and a prompt that chat kept
// unsent at the restart is sent then, once.
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { mintAgentSessionOperationId } from '../../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { rpcCallerOperationKey } from '../../runtime/rpc/callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  AUTOMATION_AGENT_CALLER,
  automationRunOperationId
} from '../launch/automation-run-operation'
import type { AutomationRunReceipt } from '../launch/automation-run-receipt'
import { structuredQueuePauses } from '../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-pause'
import { queuePauseHolding } from '../../native-chat/agent-session-journal/queued-messages/queued-message-pause'

/** The chat holding a self-sent run's prompt when Orca quit before saving that chat, found by the
 *  prompt's run-derived id; null when none holds it (the run can't be confirmed, as for any run). */
export async function selfSentRunReceipt(
  runtime: OrcaRuntimeService,
  run: Pick<AutomationRun, 'id' | 'createdAt'>
): Promise<AutomationRunReceipt | null> {
  const messageId = automationRunOperationId(run, 'run-message')
  const records = await runtime.openAgentSessionRecordStore()
  const [sessionId] = await records.chatsHoldingMessage(messageId)
  const workspaceId = sessionId && records.getConversation(sessionId)?.location.workspaceId
  return sessionId && workspaceId
    ? { kind: 'chat', sessionId, workspaceId, messageId, accepted: true }
    : null
}

/** Sends a self-sent run's prompt that its chat kept unsent when Orca restarted, unless someone
 *  acted on it since (Stop, close, a hold or a refusal). Sending consumes the kept card, and a
 *  consumed card is never sent again. */
export async function sendRunPromptKeptAtRestart(
  runtime: OrcaRuntimeService,
  run: Pick<AutomationRun, 'id' | 'createdAt' | 'chatSessionId'>,
  signal: AbortSignal
): Promise<void> {
  const sessionId = run.chatSessionId
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  const opened = sessionId && (await host?.conversation(sessionId))
  const fence = sessionId ? host?.deps.store.getConversation(sessionId)?.currentFence : undefined
  if (!host || !sessionId || !opened || fence === undefined) {
    return
  }
  const messageId = automationRunOperationId(run, 'run-message')
  const { journal } = opened
  const [submission, card, pauses, sends] = await Promise.all([
    journal.reads.submission(messageId),
    journal.queuedMessages.get(messageId),
    structuredQueuePauses(journal),
    journal.reads.input({ kind: 'linked-to', messageId })
  ])
  // Kept by a restart and nothing since: its last send was cut by a restart (not Stopped, closed or
  // refused), and only the restart's pause holds it, as the queue itself would read it.
  const lastSend = sends.submissions.at(-1) ?? submission
  if (
    !card ||
    lastSend?.rejection?.kind !== 'hostRestarted' ||
    queuePauseHolding(pauses, card)?.reason !== 'restarted'
  ) {
    return
  }
  // A teardown that began during the reads never starts the agent's turn.
  signal.throwIfAborted()
  const fields = { messageId }
  const sent = await host.queuedMessageSend(
    { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
    {
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.queuedMessageSend',
          sessionId,
          fields
        })
      },
      ...fields
    }
  )
  if (!sent.ok) {
    // The card stays in its chat, where the run waits for it like any queued prompt.
    console.warn('[automations] could not send a run prompt kept at restart:', sent.refusal)
  }
}
