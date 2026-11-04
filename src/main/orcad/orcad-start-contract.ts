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
  /** Slots have no browser client; orca serve supplies the installed app client. */
  webClientRoot?: string
}

export type OrcadHandle = {
  readiness: ServeReadiness
  managedStop: OrcadManagedStopContext
  stop(): Promise<void>
}
