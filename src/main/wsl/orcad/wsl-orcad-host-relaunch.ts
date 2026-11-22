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
import type { WslOrcadLaunchMode } from './wsl-orcad-active-probe'
import type { ServeReadiness } from '../../server/serve-readiness'

/** What the connect serves after checking a server started without the WSL host marker. */
export type WslOrcadHostRelaunch =
  | {
      ready: true
      /** Set when the server restarted and was probed again. */
      readiness: ServeReadiness | null
      /** Set when it still lacks the marker: the host row offers Restart as WSL host. */
      deferredUpdate: WslHostDeferredUpdate | null
    }
  /** A stop may have been sent or is held: the connect must not report this server ready. */
  | { ready: false; deferredUpdate: WslHostDeferredUpdate }

// Environments this run already restarted once: if the server comes back without the marker (an
// SSH client woke it first), later connects only offer the restart instead of bouncing it again.
const restartedThisSession = new Set<string>()

function wslHostNotWslLaunchedDeferral(fullVersion: string, reason: string): WslHostDeferredUpdate {
  return {
    candidateVersion: fullVersion,
    code: ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE,
    reason,
    // Its own action, Restart as WSL host, ends the terminals; Force update would not help.
    forceable: false
  }
}

const WSL_HOST_RELAUNCH_LOST_REASON =
  'This host’s Orca server was restarted as a WSL host, but it came back without the WSL host ' +
  'marker, likely because an SSH host started it again. Disconnect that SSH host, then restart it now.'

export async function relaunchAsWslHost(args: {
  environmentId: string
  context: OrcadRemoteContext<WslOrcadHostTarget>
  slot: OrcadSlotOptions
  fullVersion: string
  paired: PairingOffer | null
  /** A project move to this distro runs here: a restart would cut it off, as an update would. */
  moveRunning: boolean
  readIncumbent?: typeof readWslOrcadIncumbent
  /** Reads the restarted server again: its readiness, and whether it carries the marker now. */
  reprobe: () => Promise<{ readiness: ServeReadiness; launch: WslOrcadLaunchMode }>
}): Promise<WslOrcadHostRelaunch> {
  const deferred = (reason: string): Extract<WslOrcadHostRelaunch, { ready: true }> => ({
    ready: true,
    readiness: null,
    deferredUpdate: wslHostNotWslLaunchedDeferral(args.fullVersion, reason)
  })
  if (restartedThisSession.has(args.environmentId)) {
    return deferred(WSL_HOST_RELAUNCH_LOST_REASON)
  }
  if (args.moveRunning) {
    return deferred(
      'A project is moving to this host; its server restarts as a WSL host once the move finishes.'
    )
  }
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
    // A stop that may be underway is never reported ready. Any other kept stop (a lock another
    // client holds, a stale count, a withdrawn or refused stop) left the server serving.
    return stopped.mayBeStopping
      ? {
          ready: false,
          deferredUpdate: wslHostNotWslLaunchedDeferral(args.fullVersion, stopped.reason)
        }
      : deferred(stopped.reason)
  }
  restartedThisSession.add(args.environmentId)
  // The WSL transport starts it detached, with the marker.
  const wake = await wakeStoppedManagedOrcad(args.slot)
  // Fenced: another client (an SSH host) is starting it now; the probe that follows decides.
  if (wake.outcome !== 'started' && wake.outcome !== 'serving' && wake.outcome !== 'fenced') {
    throw new Error(
      wake.outcome === 'recovery-refused'
        ? wake.reason
        : `This host’s Orca server stopped to restart as a WSL host but did not start again (${wake.outcome}); connect to start it.`
    )
  }
  const { readiness, launch } = await args.reprobe()
  // An SSH client woke it first: offer the restart rather than bouncing it again.
  return launch === 'other'
    ? { ...deferred(WSL_HOST_RELAUNCH_LOST_REASON), readiness }
    : {
        ready: true,
        readiness,
        deferredUpdate: null
      }
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
