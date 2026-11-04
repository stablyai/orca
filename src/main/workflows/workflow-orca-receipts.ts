import type { TaskStatus } from '../runtime/orchestration/types'
import { isWorkflowJsonRecord } from '../../shared/workflow/workflow-json-record'

/** Defensive readers for Orca receipts; a missing field reads as unknown, never as success. */

export type WorkflowMailMessage = {
  id: string
  from: string
  to: string
  type: string
  subject: string
  body: string
  payload: string | null
  createdAt: string
}

export type WorkflowWorkerStartReceipt = {
  orcaDispatchId: string | null
  orcaTaskId: string | null
  terminalHandle: string | null
  worktreeId: string | null
  state: string
  effective: { agent: string | null; model: string | null; effort: string | null } | null
  failedStage: string | null
  error: string | null
}

export type WorkflowOrcaTaskSnapshot = { status: TaskStatus; result: string | null }
export type WorkflowOrcaDispatchSnapshot = {
  status: string
  workerState: string | null
  lastFailure: string | null
}

export function record(value: unknown): Record<string, unknown> {
  return isWorkflowJsonRecord(value) ? value : {}
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseStartReceipt(result: unknown): WorkflowWorkerStartReceipt {
  const receipt = record(result)
  const effective = record(record(receipt.launch).effective)
  const worker = record(receipt.worker)
  return {
    orcaDispatchId: text(receipt.dispatchId),
    orcaTaskId: text(receipt.taskId),
    terminalHandle: text(receipt.terminal) ?? text(receipt.terminalHandle) ?? text(worker.terminal),
    worktreeId: text(receipt.worktreeId) ?? text(record(receipt.worktree).id),
    state: text(receipt.state) ?? 'unknown',
    effective: record(receipt.launch).effective
      ? {
          agent: text(effective.agent),
          model: text(effective.model),
          effort: text(effective.effort)
        }
      : null,
    failedStage: text(receipt.failedStage),
    error: text(receipt.error) ?? text(receipt.reason)
  }
}

export function parseMail(row: unknown): WorkflowMailMessage {
  const message = record(row)
  return {
    id: text(message.id) ?? '',
    from: text(message.from_handle) ?? text(message.from) ?? '',
    to: text(message.to_handle) ?? text(message.to) ?? '',
    type: text(message.type) ?? 'status',
    subject: typeof message.subject === 'string' ? message.subject : '',
    body: typeof message.body === 'string' ? message.body : '',
    payload: text(message.payload),
    createdAt: text(message.created_at) ?? text(message.createdAt) ?? new Date().toISOString()
  }
}
