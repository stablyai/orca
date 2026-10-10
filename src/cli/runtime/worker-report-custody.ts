import { randomUUID } from 'node:crypto'
import { parseOrcaSessionAddress } from '../../shared/orca-session-address'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcSuccess
} from '../../shared/runtime-rpc-envelope'
import {
  WorkerReportOutbox,
  WorkerReportRequestConflictError
} from '../../shared/worker-report-outbox'
import { WorkerReportInputSchema } from '../../shared/worker-report-record'
import { workerReportDisposition } from '../../shared/worker-report-recovery'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { RuntimeClientError } from './types'

export function isWorkerReport(method: string, params: unknown): boolean {
  return (
    method === 'orchestration.send' &&
    params !== null &&
    typeof params === 'object' &&
    'type' in params &&
    params.type === 'worker_done' &&
    'from' in params &&
    typeof params.from === 'string' &&
    params.from.length > 0 &&
    !parseOrcaSessionAddress(params.from)
  )
}

export function callWithLocalWorkerReportRecovery<TResult>(args: {
  method: string
  params: unknown
  userDataPath: string
  remote: boolean
  compatibility: RuntimeOrchestrationEnvelope
  options?: RuntimeOrchestrationEnvelope
  send: (envelope?: RuntimeOrchestrationEnvelope) => Promise<RuntimeRpcSuccess<TResult>>
}): Promise<RuntimeRpcSuccess<TResult>> {
  const evidence =
    args.options?.orchestrationCompatibilityEvidence ??
    args.compatibility.orchestrationCompatibilityEvidence
  if (args.remote || evidence?.agentSessionId || !isWorkerReport(args.method, args.params)) {
    return args.send()
  }
  return callWithWorkerReportCustody({
    userDataPath: args.userDataPath,
    params: args.params,
    options: {
      ...args.compatibility,
      ...args.options,
      orchestrationCompatibilityEvidence: evidence
    },
    send: args.send
  })
}

export async function callWithWorkerReportCustody<TResult>(args: {
  userDataPath: string
  params: unknown
  options: RuntimeOrchestrationEnvelope
  send: (envelope: RuntimeOrchestrationEnvelope) => Promise<RuntimeRpcSuccess<TResult>>
}): Promise<RuntimeRpcSuccess<TResult>> {
  const requestId = args.options.orchestrationRequestId ?? randomUUID()
  const parsed = WorkerReportInputSchema.safeParse({
    requestId,
    params: args.params,
    envelope: {
      ...args.options,
      orchestrationRequestId: requestId,
      orchestrationCapability: args.options.orchestrationCapability,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      compatibilityInvocationId: requestId
    }
  })
  if (!parsed.success) {
    return args.send({ ...args.options, orchestrationRequestId: requestId })
  }
  const store = new WorkerReportOutbox(args.userDataPath)
  let saved = false
  try {
    await store.enqueue(parsed.data)
    saved = true
  } catch (error) {
    if (error instanceof WorkerReportRequestConflictError) {
      throw error
    }
    // Recovery storage must never prevent a report reaching a healthy runtime.
  }
  if (saved) {
    try {
      await store.claim(requestId, Date.now())
    } catch {
      // The acknowledged enqueue still owns the original report if a claim fails.
    }
  }
  let response: RuntimeRpcSuccess<TResult>
  try {
    response = await args.send(parsed.data.envelope)
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'transport_unknown'
    const disposition = workerReportDisposition({
      id: requestId,
      ok: false,
      error: { code, message: '' }
    })
    if (disposition.rejected) {
      if (saved) {
        await store.settle(requestId, disposition.rejected).catch(() => undefined)
      }
      throw error
    }
    if (saved) {
      throw pendingReport(requestId)
    }
    throw new RuntimeClientError(
      'worker_report_not_saved',
      `Completion report ${requestId} is not confirmed and automatic recovery could not be saved. Retry the exact original command with --retry-request ${requestId}; do not send a new completion.`,
      { orchestrationRequestId: requestId, custody: 'none' }
    )
  }
  const disposition = workerReportDisposition(response)
  if (saved && (disposition.accepted || disposition.rejected)) {
    // Recovery verifies the original receipt or still-active Dispatch before replay.
    await store.settle(requestId, disposition.rejected).catch(() => undefined)
  }
  return response
}

function pendingReport(requestId: string): RuntimeClientError {
  return new RuntimeClientError(
    'worker_report_pending',
    `Completion report ${requestId} is durably saved but settlement is not confirmed. Orca can retry when this profile runtime verifies the original local Dispatch. If it stays pending, inspect the original Task and Dispatch; do not send a new completion.`,
    { orchestrationRequestId: requestId, custody: 'local_outbox' }
  )
}
