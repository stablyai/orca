/**
 * The orcad a WSL host already runs, read before an app update replaces it (Track E1). SSH asks
 * it through its tunnel; a WSL host has no standing tunnel during deploy, so this opens a
 * short-lived stdio bridge. Anything unproven reads as an unverifiable census, never zero.
 */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import {
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../shared/orcad-terminal-census'
import type { ServeReadiness } from '../server/serve-readiness'
import { probeActiveOrcadReadiness } from '../ssh/orcad-active-readiness'
import { orcadBoundPort } from '../managed-server/lifecycle/orcad-managed-bound-port'
import { managedOrcadInstallDir } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { readRemoteOrcadBuildHash } from '../managed-server/install/orcad-remote-build-hash'
import {
  requestOrcadTerminalCensus,
  type OrcadTerminalCensusRequestOptions
} from '../ssh/orcad-terminal-census-client'
import { updateTerminalCounts } from '../ssh/orcad-fenced-stop'
import { tunneledOrcadPairingCode } from '../ssh/orcad-tunneled-pairing'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

export type WslOrcadIncumbent = {
  census: OrcadTerminalCensus
  /** The incumbent's proven readiness; null when it could not be started or proven. */
  readiness: ServeReadiness | null
  /**
   * Counts again (no wake) just before activation stops the incumbent, closing its terminal
   * admission first so none starts before the stop; never zero unread.
   */
  recount: () => Promise<OrcadTerminalCensus>
  /** Reopens the admission `recount` closed, when the incumbent keeps running. */
  releaseAdmission: () => Promise<void>
}

type IncumbentArgs = {
  context: OrcadRemoteContext<WslOrcadHostTarget>
  slot: OrcadSlotOptions
  /** This desktop's enrolled pairing; null before its first pairing. */
  paired?: PairingOffer | null
}

const UNREADABLE: WslOrcadIncumbent = {
  census: UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
  readiness: null,
  recount: async () => UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
  releaseAdmission: async () => {}
}

export type WslOrcadIncumbentDependencies = {
  wake: typeof wakeStoppedManagedOrcad
  probe: typeof probeActiveOrcadReadiness
  readBuildHash: typeof readRemoteOrcadBuildHash
  listen: (
    transport: OrcadHostTransport,
    remotePort: number,
    target: WslOrcadHostTarget
  ) => Promise<StartedPortForward>
  census: typeof requestOrcadTerminalCensus
}

const DEFAULT_DEPENDENCIES: WslOrcadIncumbentDependencies = {
  wake: wakeStoppedManagedOrcad,
  probe: probeActiveOrcadReadiness,
  readBuildHash: readRemoteOrcadBuildHash,
  listen: (transport, remotePort, target) =>
    listenWslOrcadStdioBridge(transport, {
      environmentId: target.id,
      remotePort,
      localPort: 0,
      label: `Orca server in WSL: ${target.label} (update check)`
    }),
  census: requestOrcadTerminalCensus
}

/**
 * Wakes the active slot if a reboot or idle exit stopped it (its daemon then starts empty, so
 * the census proves zero), then asks it for its census over a bridge closed before returning.
 */
export async function readWslOrcadIncumbent(
  args: IncumbentArgs,
  dependencies: WslOrcadIncumbentDependencies = DEFAULT_DEPENDENCIES
): Promise<WslOrcadIncumbent> {
  const record = args.context.activationRecord
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!record.active || !Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNREADABLE
  }
  let readiness: ServeReadiness
  try {
    const wake = await dependencies.wake(args.slot)
    if (wake.outcome === 'started') {
      readiness = wake.readiness
    } else if (wake.outcome === 'serving') {
      const remoteInstallDir = managedOrcadInstallDir(args.context, record.active)
      readiness = await dependencies.probe(
        { ...args.slot, remoteInstallDir },
        {
          buildHash: await dependencies.readBuildHash(args.slot, remoteInstallDir),
          fullVersion: record.active
        }
      )
    } else {
      return UNREADABLE
    }
  } catch {
    return UNREADABLE
  }
  const counts = updateTerminalCounts((options) =>
    countIncumbentTerminals(args, readiness, activatedAt, dependencies, options)
  )
  return {
    census: await counts.countFirst(),
    readiness,
    recount: counts.recountCensus,
    releaseAdmission: counts.releaseIncumbentAdmission
  }
}

async function countIncumbentTerminals(
  args: IncumbentArgs,
  readiness: ServeReadiness,
  activatedAt: number,
  dependencies: WslOrcadIncumbentDependencies,
  options: OrcadTerminalCensusRequestOptions
): Promise<OrcadTerminalCensus> {
  let forward: StartedPortForward | null = null
  try {
    forward = await dependencies.listen(
      args.slot.conn,
      orcadBoundPort(readiness) ?? ORCAD_MANAGED_REMOTE_PORT,
      args.context.target
    )
    // Why the enrolled grant: counting with the startup offer would enroll a new device each start.
    const offer = parsePairingCode(
      tunneledOrcadPairingCode(readiness, forward.entry.localPort, args.paired)
    )
    if (!offer) {
      return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
    }
    return await dependencies.census(
      pairedRuntimeConnectionFromOffer(offer),
      activatedAt,
      undefined,
      options
    )
  } catch {
    return UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
  } finally {
    await forward?.close().catch(() => {})
  }
}
