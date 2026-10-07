import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from './orca-runtime'

/**
 * A headless host has no renderer to publish a graph. Without this empty one the graph never
 * reads as ready, so status clients see an unready server and `session.tabs.listAll` waits on
 * an inventory publication that never comes.
 */
export function publishHeadlessRuntimeGraph(
  runtime: Pick<OrcaRuntimeService, 'syncWindowGraph'>
): void {
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
}
