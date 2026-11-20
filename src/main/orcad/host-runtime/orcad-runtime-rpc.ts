import { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import { getOrcaProfileDirectory } from '../../orca-profiles/profile-storage-paths'
import { orcadServedProfileId } from '../orcad-served-profile'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrcadOptions } from '../serve-startup/orcad-start-contract'
import { resolveOrcadWebClientRoot } from '../serve-startup/orcad-command-arguments'
import {
  clearDesktopRuntimeFallbackPort,
  orcadWsPortOptions
} from '../serve-startup/orcad-ws-port-policy'

export function createOrcadRuntimeRpcServer(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  options: OrcadOptions,
  bindHost: string
): OrcaRuntimeRpcServer {
  clearDesktopRuntimeFallbackPort(userDataPath)
  const profileId = orcadServedProfileId()
  return new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    credentialVaultDirectory: profileId
      ? getOrcaProfileDirectory(profileId, userDataPath)
      : undefined,
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
