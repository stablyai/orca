import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from './orca-runtime'

/** Publish readiness without a renderer so status and session-tab inventory do not wait forever. */
export function publishHeadlessRuntimeGraph(
  runtime: Pick<OrcaRuntimeService, 'syncWindowGraph'>
): void {
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
}
