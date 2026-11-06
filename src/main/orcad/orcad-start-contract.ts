import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadManagedStopContext } from '../../shared/orcad-stop-request'

export type OrcadOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Request a mobile-scoped pairing offer and terminal QR. */
  mobilePairing?: boolean
  grantDesktopControl?: boolean
  /** Print only the ephemeral-VM recipe line. */
  recipeJson?: boolean
  projectRoot?: string
  bind?: string
  /** Accept clients from public addresses, not only localhost, LAN and Tailscale. */
  allowPublic?: boolean
  /** Refuse public addresses even when grandfathered or otherwise accepted. */
  refusePublic?: boolean
  /** Slots have no browser client; orca serve supplies the installed app client. */
  webClientRoot?: string
}

export type OrcadHandle = {
  readiness: ServeReadiness
  managedStop: OrcadManagedStopContext
  stop(): Promise<void>
}
