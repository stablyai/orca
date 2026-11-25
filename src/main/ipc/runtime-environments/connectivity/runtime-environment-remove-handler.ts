import { handleRuntimeEnvironmentChannel } from '../runtime-environment-channel-handling'
import {
  removeEnvironment,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type RuntimeEnvironmentRemoval
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { removeThroughOwningService } from './runtime-environment-host-service-ops'
import { retireRemovedRuntimeEnvironment } from '../catalog/runtime-environment-removal-cleanup'
import { runBeforeRuntimeEnvironmentRemoval } from '../catalog/runtime-environment-removal-hooks'
import { removeRedundantManagedPairing } from '../catalog/runtime-environment-redundant-managed-removal'
import { assertWslHostReachable } from '../../../wsl/host-lifecycle/wsl-host-gate'
import { closeRemoteRuntimeRequestConnection } from '../connections/runtime-environment-request-connections'
import type { Store } from '../../../persistence/loading-store/store'

export type ConnectivityHandlerOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}

export function closeLegacySelectorTransport(selector: string, environmentId: string): void {
  if (selector === environmentId) {
    return
  }
  closeRemoteRuntimeRequestConnection(selector)
}

/** Removing a server pairing: through the service that owns it, or from the store. */
export function registerRuntimeEnvironmentRemoveHandler({
  store,
  getUserDataPath,
  invalidateTransport
}: ConnectivityHandlerOptions): void {
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:remove',
    async (
      _event,
      args: { selector: string }
    ): Promise<RuntimeEnvironmentRemoval | Promise<RuntimeEnvironmentRemoval>> => {
      const environment = await resolveEnvironment(getUserDataPath(), args.selector)
      if (store.getSettings().activeRuntimeEnvironmentId === environment.id) {
        throw new Error(
          'This server is the default host for new projects. Choose another one under New projects open on before removing it.'
        )
      }
      // A closed gate leaves persisted WSL hosts untouched on disk.
      assertWslHostReachable(environment)
      const ownedRemoval = removeThroughOwningService(environment)
      if (ownedRemoval) {
        // A WSL host whose server Remove couldn't prove stopped stays listed; say so (E11).
        return ownedRemoval.then((serverStop) => ({
          removed: redactRuntimeEnvironment(environment),
          serverStop
        }))
      }
      const redundantManagedRemoval = await removeRedundantManagedPairing(
        getUserDataPath(),
        environment
      )
      if (redundantManagedRemoval) {
        closeLegacySelectorTransport(args.selector, environment.id)
        return redundantManagedRemoval
      }
      // While the pairing still holds its credential: what its agents' asks are owed goes back first.
      await runBeforeRuntimeEnvironmentRemoval(environment.id)
      const removed = await removeEnvironment(getUserDataPath(), args.selector)
      void retireRemovedRuntimeEnvironment(
        removed.id,
        invalidateTransport,
        store,
        getUserDataPath()
      )
      closeLegacySelectorTransport(args.selector, removed.id)
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
}
