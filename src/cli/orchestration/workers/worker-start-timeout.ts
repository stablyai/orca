import type { OrchestrationMutationRequestShowResult } from '../../../shared/orchestration/orchestration-mutation-request'
import type { RuntimeRpcSuccess } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeClient } from '../../runtime/client'
import { isRequestUnsent } from '../../runtime/connection/client-error-recovery'
import { RuntimeClientError, RuntimeRpcFailureError } from '../../runtime/connection/types'
import { renderCommand } from '../recovery/orchestration-mutation-recovery'
import { resolveOrchestrationCliExecutable } from '../recovery/orchestration-recovery-command'
import type { WorkerStartAgentReceipt } from './worker-start-agent-view'

const RECEIPT_READ_TIMEOUT_MS = 5_000

export async function reconcileWorkerStartTimeout(
  client: Pick<RuntimeClient, 'call' | 'environmentSelector' | 'isRemote'>,
  error: unknown
): Promise<RuntimeRpcSuccess<WorkerStartAgentReceipt> | undefined> {
  if (
    !(error instanceof RuntimeClientError) ||
    error.code !== 'runtime_timeout' ||
    isRequestUnsent(error)
  ) {
    return undefined
  }
  const data = error.data
  if (
    !data ||
    typeof data !== 'object' ||
    !('orchestrationRequestId' in data) ||
    typeof data.orchestrationRequestId !== 'string' ||
    !data.orchestrationRequestId
  ) {
    return undefined
  }
  const request = data.orchestrationRequestId
  const on = 'server' in data && typeof data.server === 'string' ? data.server : undefined
  const response = await client
    .call<OrchestrationMutationRequestShowResult>(
      'orchestration.requestShow',
      { request, ...(on ? { on } : {}) },
      { timeoutMs: RECEIPT_READ_TIMEOUT_MS }
    )
    .catch(() => undefined)
  const record = response?.result
  if (!response || record?.requestId !== request || record.method !== 'orchestration.workerStart') {
    return undefined
  }
  const receipt = record.receipt
  if (record.state === 'completed' && isWorkerStartReceipt(receipt)) {
    return { ...response, result: receipt }
  }
  const dispatchId = record.state === 'pending' ? acceptedDispatchId(receipt) : undefined
  if (!dispatchId) {
    return undefined
  }
  const queryCommand = [
    resolveOrchestrationCliExecutable(),
    'orchestration',
    ...(on
      ? ['request-show', '--request', request, '--on', on]
      : ['worker-show', '--dispatch', dispatchId]),
    ...(client.environmentSelector ? ['--environment', client.environmentSelector] : []),
    '--json'
  ]
  const connection = client.isRemote && !client.environmentSelector ? ' using the same pairing' : ''
  const step = `To check now, run ${renderCommand(queryCommand)}${connection}.`
  // Facts only: what Orca does next, never what the agent should do.
  const message = `Orca accepted worker ${dispatchId} and is still starting it. Orca mails you if its start fails or stalls; once it runs, its reports come as mail too. ${step}`
  const originalRecovery = 'recovery' in data ? data.recovery : undefined
  const recoveredData = {
    ...data,
    dispatchId,
    recovery: {
      ...(originalRecovery && typeof originalRecovery === 'object' ? originalRecovery : {}),
      orchestrationRequestId: request,
      dispatchId,
      disposition: 'in_progress',
      workerDeathInferred: false,
      queryCommand
    },
    // The generic timeout's retry steps don't apply: Orca already has the start.
    nextSteps: []
  }
  if (error instanceof RuntimeRpcFailureError) {
    throw new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, message, data: recoveredData }
    })
  }
  throw new RuntimeClientError(error.code, message, recoveredData)
}

function acceptedDispatchId(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== 'object' || !('accepted' in receipt)) {
    return undefined
  }
  const accepted = receipt.accepted
  return accepted &&
    typeof accepted === 'object' &&
    'dispatchId' in accepted &&
    typeof accepted.dispatchId === 'string'
    ? accepted.dispatchId
    : undefined
}

function isWorkerStartReceipt(value: unknown): value is WorkerStartAgentReceipt {
  return (
    value !== null &&
    typeof value === 'object' &&
    'dispatchId' in value &&
    typeof value.dispatchId === 'string' &&
    'taskId' in value &&
    typeof value.taskId === 'string' &&
    'state' in value &&
    typeof value.state === 'string' &&
    (!('effects' in value) || value.effects == null || Array.isArray(value.effects)) &&
    (!('residualResources' in value) ||
      value.residualResources == null ||
      Array.isArray(value.residualResources)) &&
    (!('nextCommands' in value) ||
      value.nextCommands === undefined ||
      (Array.isArray(value.nextCommands) &&
        value.nextCommands.every((command) => typeof command === 'string')))
  )
}
