import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import type {
  BrowserClientHostPlacementPreference,
  BrowserPageCreationPlacement
} from '../../shared/browser-client-host-placement'
import { expectsBrowserClientHosting } from '../../shared/browser-client-hosting-eligibility'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'

const SERVER_PLACEMENT = Object.freeze({ kind: 'server' as const })

type BrowserClientHostPlacementPreparationOptions = {
  selector: string
  expectedPairingRevision?: number
  preference: BrowserClientHostPlacementPreference
  enabled: boolean
  resolveEnvironment: (selector: string) => KnownRuntimeEnvironment
  getStatus: (environmentId: string) => Promise<RuntimeRpcResponse<RuntimeStatus>>
  startHost: (options: {
    environment: KnownRuntimeEnvironment
    authorityRuntimeId: string
  }) => Promise<BrowserClientHostLeaseAuthority>
  closeHost: (environmentId: string, error?: Error) => Promise<boolean>
}

export async function prepareBrowserClientHostPlacement(
  options: BrowserClientHostPlacementPreparationOptions
): Promise<BrowserPageCreationPlacement> {
  // Why a partial check here: everything below costs a status round-trip, and these two inputs are
  // already known. The authoritative decision is made once the status arrives, so a drift in this
  // shortcut costs a wasted round-trip rather than a wrong placement.
  if (!options.enabled || options.preference === 'server') {
    return SERVER_PLACEMENT
  }

  const initialEnvironment = options.resolveEnvironment(options.selector)
  const pairingRevision = requireCurrentPairing(initialEnvironment, options.expectedPairingRevision)
  const response = await options.getStatus(initialEnvironment.id)
  if (!response.ok) {
    // Why server instead of a throw: an unanswered probe never told us whether this host can
    // client-host, and every create probes now that the renderer no longer gates on cached
    // capabilities — so rethrowing would turn one flaky `status.get` (its own fresh socket, 15s
    // ceiling) into a failed create that server placement completes. The tabCreate right behind
    // this rides the same link and reports a genuinely dead connection itself.
    return SERVER_PLACEMENT
  }
  const status = response.result
  if (status.runtimeId !== response._meta.runtimeId) {
    throw new Error('browser_client_host_runtime_identity_changed')
  }
  const environment = options.resolveEnvironment(initialEnvironment.id)
  requireCurrentPairing(environment, pairingRevision)
  if (
    !expectsBrowserClientHosting({
      enabled: options.enabled,
      preference: options.preference,
      deviceScope: status.deviceScope,
      capabilities: status.capabilities
    })
  ) {
    return SERVER_PLACEMENT
  }
  if (status.graphStatus !== 'ready') {
    throw new Error('browser_client_host_runtime_not_ready')
  }

  const authority = await options.startHost({
    environment,
    authorityRuntimeId: status.runtimeId
  })
  const currentEnvironment = options.resolveEnvironment(initialEnvironment.id)
  try {
    requireCurrentPairing(currentEnvironment, pairingRevision)
    if (authority.authorityRuntimeId !== status.runtimeId) {
      throw new Error('browser_client_host_runtime_identity_changed')
    }
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error))
    await options.closeHost(initialEnvironment.id, reason).catch(() => false)
    throw reason
  }
  return Object.freeze({
    kind: 'client',
    browserHostClientId: authority.browserHostClientId
  })
}

function requireCurrentPairing(
  environment: KnownRuntimeEnvironment,
  expectedRevision: number | undefined
): number {
  const revision = environment.pairingRevision ?? environment.createdAt
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new Error('browser_client_host_pairing_changed')
  }
  return revision
}
