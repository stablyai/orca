import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { MobileRelayStatus } from '../../shared/remote-runtime/relay/mobile-relay-status'
import { installRelayHost, type RelayHost } from '../runtime/mobile-cloud-relay/relay-host-install'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type { BackendServiceCleanup } from '../backend/service-composition'

export type OrcadRelay = Pick<RelayHost, 'accountChanged' | 'signOutStarted'> & {
  start: (rpc: OrcaRuntimeRpcServer) => void
}

/**
 * orcad's relay, as its own Orca account and keys, so phones reach it without a direct path.
 * Created before the account so its sign-in and sign-out hooks always find it.
 */
export function createOrcadRelay(
  registerCleanup: (cleanup: BackendServiceCleanup) => void,
  install: typeof installRelayHost = installRelayHost
): OrcadRelay {
  let host: RelayHost | null = null
  let stopping = false
  let lastStatus: MobileRelayStatus | null = null
  return {
    accountChanged: () => host?.accountChanged(),
    signOutStarted: () => host?.signOutStarted(),
    // Call after RPC starts and automations register their cleanups: cleanups run newest first, so
    // the fence comes before both.
    start: (rpc) => {
      const app = getAppEnvironment()
      const started = install({
        runtimeRpc: rpc,
        userDataPath: app.getPath('userData'),
        appVersion: app.getVersion(),
        // orcad applies no persisted proxy.
        whenNetworkReady: Promise.resolve(),
        isFenced: () => stopping,
        // No window shows it; the log is where an operator looks.
        onStatus: (status) => {
          if (status !== lastStatus) {
            lastStatus = status
            console.error(`[orcad] relay ${status}`)
          }
        }
      })
      host = started
      registerCleanup(() => {
        stopping = true
        started.fence()
        started.stop()
      })
    }
  }
}
