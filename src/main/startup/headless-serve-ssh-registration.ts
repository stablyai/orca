import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerSshHandlers } from '../ipc/ssh'
import { mainProcessState as state } from './main-process-state'

/**
 * Loads the profile's SSH targets on an `orca serve` host before any window exists.
 * Why: only window attach registered the SSH layer, so a headless serve listed no targets and
 * every connect threw ssh_handlers_not_registered (#25886, #8489). A later window attach
 * re-registers idempotently; until then broadcasts are skipped because there is no window.
 */
export function registerHeadlessServeSshHandlers(store: Store, runtime: OrcaRuntimeService): void {
  registerSshHandlers(store, () => state.mainWindow ?? null, runtime)
}
