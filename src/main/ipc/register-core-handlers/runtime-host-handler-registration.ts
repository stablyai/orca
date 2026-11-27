import { app } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import {
  registerRuntimeEnvironmentHandlers,
  invalidateRuntimeEnvironmentTransport
} from '../runtime-environments/runtime-environments'
import { canCreateWslHostService } from '../wsl/wsl-host-service-availability'

export async function registerRuntimeHostHandlers(
  store: Store,
  hostInitialization?: Promise<void>
): Promise<void> {
  const tasks: Promise<void>[] = [registerRuntimeEnvironmentHandlers(store, hostInitialization)]
  if (process.platform === 'win32' || canCreateWslHostService()) {
    tasks.push(
      import('../wsl/wsl-host-handlers').then(({ registerWslHostHandlers }) =>
        registerWslHostHandlers({
          store,
          hostInitialization,
          getUserDataPath: () => app.getPath('userData'),
          invalidateTransport: invalidateRuntimeEnvironmentTransport
        })
      )
    )
  }
  await Promise.all(tasks)
}
