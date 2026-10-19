/**
 * The orcad a WSL host already runs, read before an app update replaces it (Track E1). SSH asks
 * it through its tunnel; a WSL host has no standing tunnel during deploy, so this opens a
 * short-lived stdio bridge. Anything unproven reads as an unverifiable census, never zero.
 */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { ServeReadiness } from '../server/serve-readiness'
import { probeActiveOrcadReadiness } from '../ssh/orcad-active-readiness'
import { orcadBoundPort } from '../managed-server/lifecycle/orcad-managed-bound-port'
import { managedOrcadInstallDir } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { readRemoteOrcadBuildHash } from '../managed-server/install/orcad-remote-build-hash'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import { tunneledOrcadPairingCode } from '../ssh/orcad-tunneled-pairing'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

export type WslOrcadIncumbent = {
  census: OrcadTerminalCensus
  /** The incumbent's proven readiness; null when it could not be started or proven. */
  readiness: ServeReadiness | null
  /** Counts again (no wake) just before activation stops the incumbent; null without readiness. */
  recount: (() => Promise<OrcadTerminalCensus>) | null
}

const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
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
  args: {
    context: OrcadRemoteContext<WslOrcadHostTarget>
    slot: OrcadSlotOptions
  },
  dependencies: WslOrcadIncumbentDependencies = DEFAULT_DEPENDENCIES
): Promise<WslOrcadIncumbent> {
  const record = args.context.activationRecord
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!record.active || !Number.isFinite(activatedAt) || activatedAt < 0) {
    return { census: UNVERIFIABLE, readiness: null, recount: null }
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
      return { census: UNVERIFIABLE, readiness: null, recount: null }
    }
  } catch {
    return { census: UNVERIFIABLE, readiness: null, recount: null }
  }
  const recount = (): Promise<OrcadTerminalCensus> =>
    countIncumbentTerminals(args, readiness, activatedAt, dependencies)
  return { census: await recount(), readiness, recount }
}

async function countIncumbentTerminals(
  args: { context: OrcadRemoteContext<WslOrcadHostTarget>; slot: OrcadSlotOptions },
  readiness: ServeReadiness,
  activatedAt: number,
  dependencies: WslOrcadIncumbentDependencies
): Promise<OrcadTerminalCensus> {
  let forward: StartedPortForward | null = null
  try {
    forward = await dependencies.listen(
      args.slot.conn,
      orcadBoundPort(readiness) ?? ORCAD_MANAGED_REMOTE_PORT,
      args.context.target
    )
    const offer = parsePairingCode(tunneledOrcadPairingCode(readiness, forward.entry.localPort))
    if (!offer) {
      return UNVERIFIABLE
    }
    // Why release: finished automation shells would otherwise defer every update, as on SSH.
    return await dependencies.census(
      pairedRuntimeConnectionFromOffer(offer),
      activatedAt,
      undefined,
      { releaseFinishedAutomationTerminals: true }
    )
  } catch {
    return UNVERIFIABLE
  } finally {
    await forward?.close().catch(() => {})
  }
}
