import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { installConnectorHost } from '../connector-cloud/connector-host-install'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { BackendServiceCleanup } from '../backend/service-composition'

/** orcad's connector, as its own Orca account and install id; installed before RPC admits a sign-in. */
export function installOrcadConnector(
  runtime: OrcaRuntimeService,
  store: Store,
  registerCleanup: (cleanup: BackendServiceCleanup) => void
): { connect: () => void } {
  let stopping = false
  const host = installConnectorHost({
    runtime,
    store,
    userDataPath: getAppEnvironment().getPath('userData'),
    kind: 'serve',
    isFenced: () => stopping
  })
  return {
    // orcad applies no persisted proxy, so it connects once its RPC is up. Call it after RPC and
    // automations register their cleanups: cleanups run newest first, so the fence comes before both.
    connect: () => {
      registerCleanup(async () => {
        stopping = true
        runtime.getConnectorCloud()?.fence()
        host.stop()
        await runtime.feishuLocal?.stop()
      })
      runtime.getConnectorCloud()?.connect()
    }
  }
}
