import { createOrchestrationEnvironmentTransport } from '../../ipc/runtime-environments/requests/orchestration-environment-transport'
import type { RuntimeConstructionDependencies } from '../../runtime/construction/runtime-construction-dependencies'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'

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
  bindRpc: (rpc: Pick<OrcaRuntimeRpcServer, 'getDeviceRegistry' | 'pairedDeviceTypist'>) => void
} {
  let rpc: Pick<OrcaRuntimeRpcServer, 'getDeviceRegistry' | 'pairedDeviceTypist'> | null = null
  return {
    runtimeOptions: {
      // A headless host is a Run home too; it places workers on its own paired servers (#36853).
      orchestrationEnvironmentTransport: createOrchestrationEnvironmentTransport(),
      getPairedDeviceName: (pairedDeviceId) =>
        rpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
      getPairedDeviceAccount: (pairedDeviceId, connectionClaim) =>
        rpc?.pairedDeviceTypist(pairedDeviceId, connectionClaim) ?? null
    },
    bindRpc: (server) => {
      rpc = server
    }
  }
}
