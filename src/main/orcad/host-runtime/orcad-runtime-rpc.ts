import { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrcadOptions } from '../serve-startup/orcad-start-contract'
import { resolveOrcadWebClientRoot } from '../serve-startup/orcad-command-arguments'
import { orcadWsPortOptions } from '../serve-startup/orcad-ws-port-policy'

export function createOrcadRuntimeRpcServer(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  options: OrcadOptions,
  bindHost: string
): OrcaRuntimeRpcServer {
  return new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    // Pin operator exposure across restarts; pairing must not silently widen a loopback bind.
    pinnedBindHost: bindHost,
    serveNetworkSources: {
      allowPublic: options.allowPublic === true,
      refusePublic: options.refusePublic === true,
      pairingAddress: options.pairingAddress ?? null
    },
    webClientRoot: resolveOrcadWebClientRoot(options.webClientRoot),
    ...orcadWsPortOptions(options.port)
  })
}
