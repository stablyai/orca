import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'

export async function requireWorkerDoneSettlement(
  client: RuntimeClient,
  type: string | undefined,
  payload: string | undefined,
  result: unknown
): Promise<void> {
  if (type !== 'worker_done' || hasLifecycleVerdict(result)) {
    return
  }
  const target = parseWorkerDoneTarget(payload)
  const receipt = parseWorkerDoneReceipt(result)
  if (target && receipt) {
    const [dispatchVerification, taskVerification] = await Promise.all([
      client.call<{ dispatch: { id: string; status: string } | null }>(
        'orchestration.dispatchShow',
        { task: target.taskId }
      ),
      client.call<{
        tasks: { id: string; status: string; result: string | null }[]
      }>('orchestration.taskList', { status: target.expectedStatus, run: receipt.runId })
    ]).catch(() => {
      throw workerDoneSettlementUnknown()
    })
    const task = taskVerification.result.tasks.find((candidate) => candidate.id === target.taskId)
    if (
      dispatchVerification.result.dispatch?.id === target.dispatchId &&
      dispatchVerification.result.dispatch.status === target.expectedStatus &&
      task?.status === target.expectedStatus &&
      isExactWorkerReport(task.result, receipt, target.outcome)
    ) {
      return
    }
  }
  throw workerDoneSettlementUnknown()
}

function workerDoneSettlementUnknown(): RuntimeClientError {
  return new RuntimeClientError(
    'operation_unknown',
    'The runtime accepted worker_done but did not confirm that the exact report settled its Task and Dispatch. Retry from the assigned worker after verifying its active Dispatch.'
  )
}

function parseWorkerDoneReceipt(
  result: unknown
): { messageId: string; runId: string; fromHandle?: string } | undefined {
  if (!result || typeof result !== 'object' || !('message' in result)) {
    return undefined
  }
  const message = (result as { message?: unknown }).message
  if (!message || typeof message !== 'object') {
    return undefined
  }
  const {
    id,
    run_id: runId,
    from_handle: fromHandle
  } = message as {
    id?: unknown
    run_id?: unknown
    from_handle?: unknown
  }
  return typeof id === 'string' && typeof runId === 'string'
    ? {
        messageId: id,
        runId,
        ...(typeof fromHandle === 'string' ? { fromHandle } : {})
      }
    : undefined
}

function isExactWorkerReport(
  result: string | null | undefined,
  receipt: { messageId: string; fromHandle?: string },
  outcome: 'succeeded' | 'failed'
): boolean {
  if (!result) {
    return false
  }
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    return (
      parsed.provenance === 'worker_report' &&
      parsed.outcome === outcome &&
      (parsed.messageId === receipt.messageId ||
        (receipt.fromHandle !== undefined && parsed.reportedBy === receipt.fromHandle))
    )
  } catch {
    return false
  }
}

function hasLifecycleVerdict(result: unknown): boolean {
  if (!result || typeof result !== 'object' || !('lifecycle' in result)) {
    return false
  }
  const lifecycle = (result as { lifecycle?: unknown }).lifecycle
  if (!lifecycle || typeof lifecycle !== 'object') {
    return false
  }
  const action = (lifecycle as { action?: unknown }).action
  if ('relay' in result) {
    const authority = (lifecycle as { authority?: unknown }).authority
    return (
      (authority === 'run_home' || authority === 'worker_server_legacy') &&
      (action === 'completed' || action === 'failed' || action === 'rejected')
    )
  }
  if (action === 'settled') {
    const outcome = (lifecycle as { outcome?: unknown }).outcome
    return outcome === 'succeeded' || outcome === 'failed'
  }
  return action === 'completed' || action === 'failed' || action === 'rejected'
}

function parseWorkerDoneTarget(payload: string | undefined):
  | {
      taskId: string
      dispatchId: string
      outcome: 'succeeded' | 'failed'
      expectedStatus: 'completed' | 'failed'
    }
  | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    if (
      typeof parsed.taskId !== 'string' ||
      typeof parsed.dispatchId !== 'string' ||
      (parsed.outcome !== 'succeeded' && parsed.outcome !== 'failed')
    ) {
      return undefined
    }
    return {
      taskId: parsed.taskId,
      dispatchId: parsed.dispatchId,
      outcome: parsed.outcome,
      expectedStatus: parsed.outcome === 'succeeded' ? 'completed' : 'failed'
    }
  } catch {
    return undefined
  }
}
