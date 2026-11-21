/**
 * #43632: before WSL hosts, users reached a distro through an SSH host, which starts orcad without
 * the WSL host marker. A same-version connect reuses that server, which then refuses project
 * moves. Restart it as a WSL host only when a fenced recount proves no terminal runs on it; an
 * SSH client still attached reconnects to the new server. Otherwise nothing stops, and the host
 * row offers "Restart as WSL host".
 */
import {
  ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE,
  type WslHostDeferredUpdate
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { OrcadSlotOptions } from '../../managed-server/activation/orcad-recovery-slot'
import type { OrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import { stopIdleOrcadForRestart } from '../../managed-server/lifecycle/orcad-idle-restart-stop'
import { wakeStoppedManagedOrcad } from '../../managed-server/lifecycle/orcad-managed-wake'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { readWslOrcadIncumbent } from './wsl-orcad-incumbent'

export type WslOrcadHostRelaunch =
  | { outcome: 'restarted' }
  | { outcome: 'deferred'; deferredUpdate: WslHostDeferredUpdate }

export async function relaunchAsWslHost(args: {
  context: OrcadRemoteContext<WslOrcadHostTarget>
  slot: OrcadSlotOptions
  fullVersion: string
  paired: PairingOffer | null
  readIncumbent?: typeof readWslOrcadIncumbent
}): Promise<WslOrcadHostRelaunch> {
  const deferred = (reason: string): WslOrcadHostRelaunch => ({
    outcome: 'deferred',
    deferredUpdate: {
      candidateVersion: args.fullVersion,
      code: ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE,
      reason,
      // Its own action, Restart as WSL host, ends the terminals; Force update would not help.
      forceable: false
    }
  })
  const incumbent = await (args.readIncumbent ?? readWslOrcadIncumbent)({
    context: args.context,
    slot: args.slot,
    paired: args.paired
  })
  const { census } = incumbent
  // An unanswered count is unknown, never zero; in-process terminals end with orcad itself.
  if (census.liveSessions !== 0 || (census.inProcessSessions ?? 0) !== 0) {
    return deferred(terminalsRunning(census.liveSessions))
  }
  const stopped = await stopIdleOrcadForRestart(args.slot, {
    recountCensus: incumbent.recount,
    releaseIncumbentAdmission: incumbent.releaseAdmission
  })
  if (stopped.state === 'terminals-running') {
    return deferred(terminalsRunning(stopped.liveSessions))
  }
  if (stopped.state === 'kept') {
    return deferred(stopped.reason)
  }
  // The WSL transport starts it detached, with the marker.
  const wake = await wakeStoppedManagedOrcad(args.slot)
  if (wake.outcome !== 'started' && wake.outcome !== 'serving') {
    throw new Error(
      wake.outcome === 'recovery-refused'
        ? wake.reason
        : `This host’s Orca server stopped to restart as a WSL host but did not start again (${wake.outcome}); connect to start it.`
    )
  }
  return { outcome: 'restarted' }
}

function terminalsRunning(liveSessions: number | null): string {
  const what =
    liveSessions === null
      ? 'Orca could not count its terminals'
      : `${liveSessions} terminal${liveSessions === 1 ? ' runs' : 's run'} on it`
  return (
    `This host’s Orca server was not started as a WSL host (an SSH host usually started it), and ${what}. ` +
    'It restarts as a WSL host when Orca next connects with no terminals running, or restart it now.'
  )
}
