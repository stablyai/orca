import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { WslHostDeferredUpdate } from '../../../shared/wsl-host-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { OrcadHostTransport } from '../../managed-server/install/orcad-host-transport'
import type { OrcadUpdateIntent } from '../../managed-server/lifecycle/orcad-managed-update-decision'
import type { WslDistroHolder } from '../discovery/wsl-distro-holder-types'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import type { readWslOrcadIncumbent } from './wsl-orcad-incumbent'

export type WslOrcadLaunch =
  | {
      outcome: 'ready'
      distro: string
      /** The Lxss registration GUID for the deployment record's `distroId`; null if unreadable. */
      distroId: string | null
      /** The loopback port orcad bound inside the distro (another one when the preferred was taken). */
      port: number
      fullVersion: string
      pid: number | null
      readiness: ServeReadiness
      holder: 'adopted' | 'spawned' | 'unverifiable'
      /** An orcad the record did not name (e.g. left by a failed Remove), now recorded. */
      adoptedInstance?: { version: string; pid: number }
      /** Set when `fullVersion` is the incumbent because the update must wait. */
      deferredUpdate?: WslHostDeferredUpdate
    }
  | ({ outcome: 'deferred'; distro: string } & WslHostDeferredUpdate)

export type WslOrcadDeployOptions = {
  /** The WSL environment's id; keys host-scoped state (wake dedupe). Defaults per distro. */
  environmentId?: string
  label?: string
  /** Defaults to a connect. */
  intent?: OrcadUpdateIntent
  signal?: AbortSignal
  /** Defaults to one created over `userData`; the app should pass its shared instance. */
  holder?: WslDistroHolder
  createTransport?: (target: WslOrcadHostTarget) => OrcadHostTransport & { dispose?(): void }
  readRegistryId?: (distro: string) => Promise<string | null>
  readIncumbent?: typeof readWslOrcadIncumbent
  /** This desktop's enrolled pairing, which the incumbent's terminal count authenticates with. */
  pairedOffer?: PairingOffer | null
  /** The orcad template to deploy from; defaults to the packaged one (the C10 lane swaps it). */
  templateDir?: string
  /** A no-boot connect's running check (E9), re-read before any further wake. */
  requireRunning?: () => Promise<boolean>
}
