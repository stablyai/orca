import type { DispatchCreator } from '../../orchestration/db/dispatch-depth'
import type { OrcaRuntimeService } from '../../orca-runtime'

/**
 * Identify a CLI caller for nesting-depth purposes.
 *
 * Pane key and process incarnation come from the runtime's dispatch authority
 * rather than the caller's params: remote attachment matching needs the exact
 * incarnation, and a caller cannot be trusted to report its own.
 */
export function resolveDispatchCreator(
  runtime: OrcaRuntimeService,
  callerHandle: string | undefined
): DispatchCreator {
  if (!callerHandle) {
    // No declared caller means no resolvable parent. Depth 0 is the same answer
    // the pre-existing Run-binding check already gives this case.
    return { kind: 'system' }
  }
  const authority = runtime.getOrchestrationDispatchAuthority?.(callerHandle)
  return {
    kind: 'terminal',
    handle: callerHandle,
    paneKey: authority?.paneKey ?? runtime.getTerminalPaneKey(callerHandle) ?? undefined,
    processIncarnation: authority?.processIncarnation ?? undefined
  }
}
