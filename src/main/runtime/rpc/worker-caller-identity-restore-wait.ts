import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import type { OrchestrationCallerField } from './methods/orchestration/access/orchestration-method-access'

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
  const params: unknown = request.params
  const handle =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)[callerField]
      : undefined
  // A long-poll check would spend this wait from the CLI's request budget; its handler re-resolves anyway.
  if (typeof handle !== 'string' || !handle || (params as { wait?: unknown }).wait === true) {
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
