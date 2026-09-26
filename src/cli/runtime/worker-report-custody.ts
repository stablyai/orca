import { randomUUID } from 'node:crypto'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcSuccess
} from '../../shared/runtime-rpc-envelope'
import { WorkerReportOutbox } from '../../shared/worker-report-outbox'
import { WorkerReportInputSchema } from '../../shared/worker-report-record'
import { workerReportDisposition } from '../../shared/worker-report-recovery'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { RuntimeClientError } from './types'

export function isWorkerReport(
  method: string,
  params: unknown,
  options?: RuntimeOrchestrationEnvelope
): options is RuntimeOrchestrationEnvelope & { orchestrationCapability: string } {
  return (
    method === 'orchestration.send' &&
    params !== null &&
    typeof params === 'object' &&
    'type' in params &&
    params.type === 'worker_done' &&
    typeof options?.orchestrationCapability === 'string' &&
    options.orchestrationCapability.length > 0
  )
}

export async function callWithWorkerReportCustody<TResult>(args: {
  userDataPath: string
  pairing: PairingOffer | null
  params: unknown
  options: RuntimeOrchestrationEnvelope
  send: (envelope: RuntimeOrchestrationEnvelope) => Promise<RuntimeRpcSuccess<TResult>>
}): Promise<RuntimeRpcSuccess<TResult>> {
  const requestId = args.options.orchestrationRequestId ?? randomUUID()
  const parsed = WorkerReportInputSchema.safeParse({
    requestId,
    params: args.params,
    pairing: args.pairing,
    envelope: {
      orchestrationRequestId: requestId,
      orchestrationCapability: args.options.orchestrationCapability,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      compatibilityInvocationId: requestId
    }
  })
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Durable worker reports require an exact sender, Task, Dispatch, outcome and capability.'
    )
  }
  const store = new WorkerReportOutbox(args.userDataPath)
  await store.enqueue(parsed.data)
  const record = await store.claim(requestId, Date.now())
  if (!record) {
    throw pendingReport(requestId)
  }
  try {
    const response = await args.send(record.input.envelope)
    const disposition = workerReportDisposition(response)
    if (disposition.accepted || disposition.rejected) {
      await store.settle(requestId, disposition.rejected)
    }
    return response
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
      await store.settle(requestId, disposition.rejected)
      throw error
    }
    throw pendingReport(requestId)
  }
}

function pendingReport(requestId: string): RuntimeClientError {
  return new RuntimeClientError(
    'worker_report_pending',
    `Completion report ${requestId} is durably saved but settlement is not confirmed. Orca will retry automatically when this profile runtime recovers; do not send a new completion.`,
    { orchestrationRequestId: requestId, custody: 'local_outbox' }
  )
}
