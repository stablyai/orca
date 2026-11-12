import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcRequest } from '../../core'
import type { OrchestrationCallerField } from '../../methods/orchestration/access/orchestration-method-access'
import { isDispatchMutationMessageType } from '../../../../../shared/rpc-contract/orchestration-params'

// The calls a worker makes as itself, each fenced on its terminal's pane and process.
const WORKER_REPORT_METHODS: ReadonlySet<string> = new Set([
  'orchestration.send',
  'orchestration.ask',
  'orchestration.check'
])

/**
 * While Orca restarts, a worker's terminal reads as an unknown pane and process until the startup
 * restore rebinds it; wait for that before the handler runs the unchanged identity check. Null when
 * nothing needs to wait, so ordinary admission stays synchronous.
 */
export function waitForRestoredWorkerCallerIdentity(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  callerField: OrchestrationCallerField | undefined,
  signals: readonly (AbortSignal | undefined)[]
): Promise<void> | null {
  if (!callerField || !WORKER_REPORT_METHODS.has(request.method)) {
    return null
  }
  const raw: unknown = request.params
  const params: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  const handle = params[callerField]
  // Only worker reports run the identity check; a long-poll check would also spend the CLI's budget.
  const skipsIdentityCheck =
    request.method === 'orchestration.send'
      ? typeof params.type !== 'string' || !isDispatchMutationMessageType(params.type)
      : request.method === 'orchestration.check' && params.wait === true
  if (typeof handle !== 'string' || !handle || skipsIdentityCheck) {
    return null
  }
  if (
    !runtime.startupWorkerAuthority.isPending() ||
    (runtime.getTerminalPaneKey(handle) !== null &&
      runtime.getTerminalProcessIncarnation(handle) !== null)
  ) {
    return null
  }
  return runtime.startupWorkerAuthority.wait(signals)
}
