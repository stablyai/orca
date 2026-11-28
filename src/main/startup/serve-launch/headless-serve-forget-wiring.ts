import { wireManagedServerForgetLocal } from '../../runtime/rpc/methods/managed-servers-local'
import { forgetManagedOrcadEnvironment } from '../../managed-server/lifecycle/orcad-runtime-decommission'
import { retireRemovedRuntimeEnvironment } from '../../ipc/runtime-environments/catalog/runtime-environment-removal-cleanup'
import { releaseUnlinkedHostTransport } from '../../ipc/ssh/ssh-session-teardown'
import { invalidateRuntimeEnvironmentTransport } from '../../ipc/runtime-environments/runtime-environments'
import type { Store } from '../../persistence/loading-store/store'

// The forget half of Settings' Forget… for headless serve, which registers no managed-server actions.
export function wireHeadlessServeForgetLocal(store: Store, userDataPath: () => string): void {
  wireManagedServerForgetLocal(async (selector) => {
    const policy = {
      isActiveEnvironment: (environmentId: string) =>
        store.getSettings().activeRuntimeEnvironmentId === environmentId,
      retireLocalState: (environmentId: string) =>
        retireRemovedRuntimeEnvironment(
          environmentId,
          invalidateRuntimeEnvironmentTransport,
          store,
          userDataPath()
        ),
      releaseHostTransport: releaseUnlinkedHostTransport
    }
    // Same order as the desktop action: a WSL host has no SSH target to unlink.
    const { forgetWslHostEnvironment } = await import('../../ipc/wsl/wsl-host-forget')
    const wslHost = await forgetWslHostEnvironment(userDataPath(), selector, policy)
    return wslHost ?? forgetManagedOrcadEnvironment(userDataPath(), { selector }, policy)
  })
}
