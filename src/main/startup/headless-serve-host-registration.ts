import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerSshHandlers } from '../ipc/ssh'
import { registerEphemeralVmHandlers } from '../ipc/ephemeral-vm'
import { mainProcessState as state } from './main-process-state'

// Why before RPC binds: headless clients need SSH targets and recipe services without a window.
export function registerHeadlessServeHostHandlers(store: Store, runtime: OrcaRuntimeService): void {
  registerSshHandlers(store, () => state.mainWindow ?? null, runtime)
  registerEphemeralVmHandlers(store)
}
