import { appendWorkflowEvent } from '../../shared/workflow/workflow-run-state'
import {
  estimateWorkflowTokens,
  workflowPayloadBytes
} from '../../shared/workflow/workflow-payload-policy'
import type { WorkflowRun, WorkflowTask } from '../../shared/workflow/workflow-run-types'
import type { WorkflowMailMessage } from './workflow-orca-receipts'
import { isWorkflowJsonRecord } from '../../shared/workflow/workflow-json-record'
import { recordWorkflowMessage } from './workflow-edge-delivery'
import { reconcileWorkflowRun } from './workflow-run-reconciliation'
import type { WorkflowRunSession } from './workflow-run-session'

const WAIT_MS = 30_000
const BACKOFF_MS = 3_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function findWorkflowTaskForSender(
  run: WorkflowRun,
  sender: { handle?: string; dispatchId?: string }
): WorkflowTask | null {
  for (const task of Object.values(run.tasks)) {
    for (const dispatch of task.dispatches) {
      if (
        (sender.dispatchId && dispatch.orcaDispatchId === sender.dispatchId) ||
        (sender.handle && dispatch.orcaTerminalHandle === sender.handle)
      ) {
        return task
      }
    }
  }
  return null
}

function readPayload(payload: string | null): { dispatchId?: string; rejection?: string } {
  if (!payload) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!isWorkflowJsonRecord(parsed)) {
      return {}
    }
    const rejection = parsed._orcaLifecycleRejection
    return {
      ...(typeof parsed.dispatchId === 'string' ? { dispatchId: parsed.dispatchId } : {}),
      ...(isWorkflowJsonRecord(rejection) && typeof rejection.code === 'string'
        ? { rejection: rejection.code }
        : {})
    }
  } catch {
    return {}
  }
}

function recordMail(session: WorkflowRunSession, messages: readonly WorkflowMailMessage[]): void {
  const { run } = session
  const at = session.at()
  for (const mail of messages) {
    if (run.messages.some((message) => message.orcaMessageId === mail.id)) {
      continue
    }
    const payload = readPayload(mail.payload)
    const task = findWorkflowTaskForSender(run, {
      handle: mail.from,
      dispatchId: payload.dispatchId
    })
    const refs = { task: task ?? undefined, correlationId: mail.id }
    if (mail.type === 'worker_done' && payload.rejection) {
      // Orca refused to settle it (a superseded attempt, or the wrong sender); it changes nothing here.
      appendWorkflowEvent(
        run,
        'warning',
        at,
        `Orca rejected a stale report (${payload.rejection}): ${mail.subject}`,
        refs
      )
    } else if (mail.type === 'worker_done') {
      appendWorkflowEvent(run, 'message-delivered', at, `Report received: ${mail.subject}`, refs)
    } else if (mail.type === 'question' || mail.type === 'escalation') {
      const bytes = workflowPayloadBytes(mail.body)
      recordWorkflowMessage(run, {
        edgeId: null,
        sourceNodeId: task?.nodeId ?? null,
        destinationNodeId: null,
        taskKey: task?.key ?? null,
        orcaDispatchId: task?.dispatches.at(-1)?.orcaDispatchId ?? null,
        orcaMessageId: mail.id,
        type: mail.type === 'question' ? 'question' : 'control',
        channel: 'direct',
        timestamp: mail.createdAt,
        correlationId: mail.id,
        payload: mail.body || mail.subject,
        payloadFormat: 'text',
        deliveryState: 'delivered',
        releasedAt: null,
        rejection: null,
        bytes,
        estimatedTokens: estimateWorkflowTokens(bytes)
      })
      appendWorkflowEvent(
        run,
        mail.type === 'question' ? 'question-received' : 'escalation-received',
        at,
        `${mail.type === 'question' ? 'Question' : 'Escalation'}: ${mail.subject || mail.body.slice(0, 120)}`,
        refs
      )
    }
  }
  session.persist()
}

/** Keep Orca's unfiltered waiter on the Run mailbox for as long as the run is live. */
export async function pumpWorkflowMail(session: WorkflowRunSession): Promise<void> {
  let ack: string | null = null
  while (!session.isClosed && !session.terminal) {
    const from = session.run.coordinatorTerminalHandle
    const orcaRunId = session.run.orcaRunId
    if (!from || !orcaRunId) {
      await delay(BACKOFF_MS)
      continue
    }
    try {
      const batch = await session.deps.adapter.waitForMail({
        from,
        orcaRunId,
        ack,
        timeoutMs: WAIT_MS
      })
      ack = batch.deliveryId
      if (batch.messages.length > 0) {
        await session.exclusive(() => recordMail(session, batch.messages))
        void reconcileWorkflowRun(session)
      }
    } catch (error) {
      ack = null
      if (!session.isClosed) {
        console.warn('[workflows] mail wait failed; retrying', session.run.id, error)
      }
      await delay(BACKOFF_MS)
    }
  }
}
