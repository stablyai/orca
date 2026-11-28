import { createOrchestrationEnvironmentTransport } from '../../ipc/runtime-environments/requests/orchestration-environment-transport'
import type { RuntimeConstructionDependencies } from '../../runtime/construction/runtime-construction-dependencies'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import {
  NO_SHARED_HOSTS,
  setSharedHosts
} from '../../../shared/remote-runtime/pairing/shared-host-keys'

type PairedEnvironmentRuntimeOptions = Required<
  Pick<
    RuntimeConstructionDependencies,
    'orchestrationEnvironmentTransport' | 'getPairedDeviceName' | 'getPairedDeviceAccount'
  >
>

/** Runtime options for this host's pairings: the servers it dials and the devices paired to it. */
export function createOrcadPairedEnvironmentOptions(): {
  runtimeOptions: PairedEnvironmentRuntimeOptions
  /** RPC owns the device registry and starts after the runtime. */
  bindRpc: (rpc: Pick<OrcaRuntimeRpcServer, 'pairedDeviceName' | 'pairedDeviceTypist'>) => void
} {
  let rpc: Pick<OrcaRuntimeRpcServer, 'pairedDeviceName' | 'pairedDeviceTypist'> | null = null
  // A headless host's own profile accepts no shares.
  setSharedHosts(NO_SHARED_HOSTS)
  return {
    runtimeOptions: {
      // A headless host is a Run home too; it places workers on its own paired servers (#36853).
      orchestrationEnvironmentTransport: createOrchestrationEnvironmentTransport(),
      getPairedDeviceName: (pairedDeviceId) => rpc?.pairedDeviceName(pairedDeviceId) ?? null,
      getPairedDeviceAccount: (pairedDeviceId, connectionClaim) =>
        rpc?.pairedDeviceTypist(pairedDeviceId, connectionClaim) ?? null
    },
    bindRpc: (server) => {
      rpc = server
    }
  }
}
