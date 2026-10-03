import { randomUUID } from 'node:crypto'
import type { WorkerReportInput } from '../../shared/worker-report-record'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
} from '../../shared/protocol-version'
import { evaluateRuntimeCompat } from '../../shared/protocol-compat'
import type { OrcaRuntimeService } from './orca-runtime'

export function canReplayLocalWorkerReport(
  runtime: OrcaRuntimeService,
  input: WorkerReportInput
): boolean {
  if (input.pairing) {
    return true
  }
  const db = runtime.getOrchestrationDb()
  const receipt = db.getMutationReceipt(
    db.getOrCreateLocalMutationCallerFingerprint(),
    input.requestId
  )
  if (receipt?.state === 'completed') {
    return true
  }
  // Startup graph absence is not evidence that the original Dispatch lost authority.
  return Boolean(
    runtime.getTerminalPaneKey(input.params.from) &&
    runtime.getTerminalProcessIncarnation(input.params.from)
  )
}

export async function replayWorkerReport(
  input: WorkerReportInput,
  local: (request: string) => Promise<RuntimeRpcResponse<unknown>>,
  authToken: string
): Promise<RuntimeRpcResponse<unknown>> {
  if (!input.pairing) {
    return local(
      JSON.stringify({
        id: randomUUID(),
        authToken,
        method: 'orchestration.send',
        params: input.params,
        ...input.envelope
      })
    )
  }
  try {
    return await sendRemoteRuntimeRequestWithStatusPreflight(
      input.pairing,
      'orchestration.send',
      input.params,
      15_000,
      (response) => {
        if (!response.ok) {
          throw new ReportReplayRefusal(response.error.code)
        }
        const status = response.result
        if (status.graphStatus === 'unavailable' || status.graphStatus === 'reloading') {
          throw new ReportReplayRefusal('worker_report_identity_unavailable')
        }
        const compatible = evaluateRuntimeCompat({
          clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
          serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
          serverMinCompatibleClientProtocolVersion:
            status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
        })
        if (
          compatible.kind === 'blocked' ||
          !status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)
        ) {
          throw new ReportReplayRefusal('orchestration_migration_required')
        }
      },
      input.envelope
    )
  } catch (error) {
    if (error instanceof ReportReplayRefusal) {
      return {
        id: input.requestId,
        ok: false,
        error: { code: error.code, message: 'Worker report replay refused by target runtime' }
      }
    }
    throw error
  }
}

class ReportReplayRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
