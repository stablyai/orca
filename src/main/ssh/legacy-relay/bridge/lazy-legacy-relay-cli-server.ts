import type { LegacyRelayCliServerDeps } from '../cli/legacy-relay-cli-server'
import type { LegacyRelayCliServer } from '../bridge/legacy-relay-client'

/** Loads the legacy relay CLI server (and ALL_RPC_METHODS) only if a legacy SSH relay invokes it. */
export function createLazyLegacyRelayCliServer(
  deps: LegacyRelayCliServerDeps
): LegacyRelayCliServer {
  let loaded: Promise<LegacyRelayCliServer> | null = null
  const getServer = (): Promise<LegacyRelayCliServer> =>
    (loaded ??= import('../cli/legacy-relay-cli-server').then((m) =>
      m.createLegacyRelayCliServer(deps)
    ))
  return {
    cli: (params, signal) => getServer().then((server) => server.cli(params, signal)),
    postOutput: (params, signal) => getServer().then((server) => server.postOutput(params, signal))
  }
}
