import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadManagedStopContext } from '../../shared/orcad-stop-request'

export type OrcadOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Desktop `orca serve` parity: a mobile-scoped offer with a terminal QR. */
  mobilePairing?: boolean
  /** Lets the paired runtime client drive this machine's desktop (computer.*). */
  grantDesktopControl?: boolean
  /** Desktop `orca serve` parity: print only the ephemeral-VM recipe line. */
  recipeJson?: boolean
  projectRoot?: string
  /** Literal IP to bind. Defaults to loopback; see orcad-bind-address.ts. */
  bind?: string
  /** The browser client's directory; the slot carries none, so `orca serve` passes the app's. */
  webClientRoot?: string
}

export type OrcadHandle = {
  readiness: ServeReadiness
  /** What an instance-bound stop request must name to stop this process. */
  managedStop: OrcadManagedStopContext
  stop(): Promise<void>
}
