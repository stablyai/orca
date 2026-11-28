// A run that sends its own prompt, after Orca quit inside its dispatch: its chat is found by the
// prompt's run-derived id, and a prompt that chat kept unsent at the restart is sent then, once.
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
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationService } from '../automation-service'
import { selfSentRunPlacement } from './self-sent-run-placement'

/** Sends a self-sent run's prompt that its chat kept unsent when Orca restarted. Sending consumes the
 *  kept card, and a consumed card is never sent again. */
export async function sendRunPromptKeptAtRestart(
  runtime: OrcaRuntimeService,
  run: Pick<AutomationRun, 'id' | 'createdAt' | 'chatSessionId'>
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
  const [submission, card] = await Promise.all([
    journal.reads.submission(messageId),
    journal.queuedMessages.get(messageId)
  ])
  if (submission?.rejection?.kind !== 'hostRestarted' || card?.state !== 'waiting') {
    return
  }
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

/** A self-sent run Orca quit before saving its chat: attached to the chat holding its prompt, or,
 *  when nothing holds it and the run is still claimed, handed to its own launch (`settled: null`),
 *  which settles it. A run that can't be confirmed comes back unchanged. Throws once Orca is
 *  quitting. */
export async function recoverSelfSentRun(
  deps: {
    runtime: OrcaRuntimeService
    service: Pick<AutomationService, 'resumeUnsentDispatch' | 'markDispatchResult'>
  },
  automation: Automation,
  run: AutomationRun,
  signal: AbortSignal
): Promise<{ run: AutomationRun } | { settled: null }> {
  const placed = await selfSentRunPlacement(deps.runtime, run)
  signal.throwIfAborted()
  if (placed.kind === 'chat') {
    return {
      run: await deps.service.markDispatchResult({
        runId: run.id,
        status: 'dispatched',
        sessionKind: 'chat',
        chatSessionId: placed.sessionId,
        workspaceId: placed.workspaceId,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null,
        error: null
      })
    }
  }
  // Only a run still claimed is handed on: its launch settles nothing else.
  if (placed.kind === 'unconfirmed' || run.status !== 'dispatching') {
    return { run }
  }
  deps.service.resumeUnsentDispatch(automation, run)
  return { settled: null }
}
