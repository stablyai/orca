import { app } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import {
  registerRuntimeEnvironmentHandlers,
  invalidateRuntimeEnvironmentTransport
} from '../runtime-environments/runtime-environments'
import { registerWslHostHandlers } from '../wsl/wsl-host-handlers'

export async function registerRuntimeHostHandlers(
  store: Store,
  hostInitialization?: Promise<void>
): Promise<void> {
  await Promise.all([
    registerRuntimeEnvironmentHandlers(store, hostInitialization),
    registerWslHostHandlers({
      store,
      hostInitialization,
      getUserDataPath: () => app.getPath('userData'),
      invalidateTransport: invalidateRuntimeEnvironmentTransport
    })
  ])
}
