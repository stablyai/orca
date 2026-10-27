/** C7 supplies visible demand; these production probes serve the WSL liveness supervisor. */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import {
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../shared/orcad-terminal-census'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import { subscribeSystemPowerLifecycle } from '../system-power-lifecycle'
import {
  deferUntilWslDistroRunning,
  readConfirmedRunningWslDistros
} from '../wsl-background-distro-gate'
import type { WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { readWslGuestIdentity } from './wsl-guest-process-identity'
import type { WslOrcadConnection, WslOrcadConnectionManager } from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'
import { confirmsRunning } from './wsl-orcad-liveness-evidence'
import { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { openWslOrcadWatch } from './wsl-orcad-watch'

function transportFor(distro: string, environmentId = defaultWslOrcadEnvironmentId(distro)) {
  return createWslOrcadHostTransport({
    target: { kind: 'wsl', id: environmentId, distro, label: distro }
  })
}

/** Every session counts (activation time 0): liveness asks how many survived, not how new. */
function collectWslOrcadCensus(connection: WslOrcadConnection): Promise<OrcadTerminalCensus> {
  const offer = parsePairingCode(connection.pairingOffer)
  return offer
    ? requestOrcadTerminalCensus(pairedRuntimeConnectionFromOffer(offer), 0)
    : Promise.resolve(UNVERIFIABLE_ORCAD_TERMINAL_CENSUS)
}

export function createWslOrcadLivenessSupervisor(options: {
  manager: WslOrcadConnectionManager
  holder: WslDistroHolder
  hasUserVisibleWork: (distro: string) => boolean
}): WslOrcadLivenessSupervisor {
  return new WslOrcadLivenessSupervisor({
    manager: options.manager,
    readRunning: readConfirmedRunningWslDistros,
    readIdentity: (distro, orcadPid) => readWslGuestIdentity(transportFor(distro), orcadPid),
    openWatch: (connection) =>
      openWslOrcadWatch(
        transportFor(connection.distro, connection.environmentId),
        connection.remotePort
      ),
    collectCensus: collectWslOrcadCensus,
    hasUserVisibleWork: options.hasUserVisibleWork,
    deferUntilRunning: deferUntilWslDistroRunning,
    requireRunning: async (distro) =>
      confirmsRunning(await readConfirmedRunningWslDistros(), wslDistroHolderKey(distro)),
    ensureHolder: (distro) => options.holder.ensureHeld(distro),
    subscribePower: subscribeSystemPowerLifecycle
  })
}
