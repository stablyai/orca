import type { OrcadActivationRecord } from './orcad-activation-record'
import {
  isAnsweredOrcadTerminalCensus,
  type OrcadTerminalCensus
} from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import {
  assessOrcadLiveDaemonCrossing,
  describeDaemonProtocols
} from './orcad-daemon-protocol-crossing'

import type { OrcadDaemonProtocolFacts } from './orcad-daemon-protocol-crossing'

type OrcadUpdateDecision =
  | { action: 'noop'; reason: string }
  | {
      action: 'proceed'
      preservesLiveDaemon: boolean
      notes: string[]
    }
  | {
      action: 'defer'
      code: OrcadUpdateDeferCode
      reason: string
      /** Full force may pass this: an answered, uncounted census, once the candidate proves no daemon. */
      forceable?: true
    }

/** A recount that lost the first census's in-process count cannot show no in-process terminal is starting. */
export function recountLostInProcessCount(
  first: OrcadTerminalCensus,
  recounted: OrcadTerminalCensus
): OrcadUpdateDecision | null {
  return typeof first.inProcessSessions === 'number' &&
    typeof recounted.inProcessSessions !== 'number'
    ? {
        action: 'defer',
        code: 'orcad_update_terminal_census_unavailable',
        reason:
          'The server could not count the terminals it runs itself right before the stop, so ' +
          'nothing was stopped. Orca will try the update again.'
      }
    : null
}

/**
 * `live-terminals` passes only a counted live-terminal deferral, never an uncounted census. Full force (`true`)
 * can pass an answered uncounted census and end terminals the server runs itself, so only a caller that
 * confirmed that may pass it.
 */
export type OrcadUpdateForce = boolean | 'live-terminals'

export type OrcadUpdateDeferCode =
  | 'orcad_update_terminals_running'
  | 'orcad_update_terminal_census_unavailable'
  | 'orcad_update_strands_live_terminals'
  | 'orcad_update_daemon_protocol_unverifiable'
  | 'orcad_update_ends_in_process_terminals'

/** Defer live-session mixed-build pairs unless the operator chooses force; force cannot authorize an unsupported daemon protocol. */
export function planOrcadUpdate(input: {
  record: OrcadActivationRecord
  candidateVersion: string
  census: OrcadTerminalCensus
  candidateDaemonProtocol: OrcadDaemonProtocolFacts
  /** Daemon generations the candidate found alive on the host; consulted when the census cannot name them, or under force when it is uncounted. */
  hostDaemonProtocols?: readonly number[]
  force?: OrcadUpdateForce
}): OrcadUpdateDecision {
  if (input.record.active === input.candidateVersion) {
    return {
      action: 'noop',
      reason: `${input.candidateVersion} is already the active version; nothing to restart.`
    }
  }
  // An uncounted or pre-field in-process count stays unknown here; only force may pass it, below.
  const inProcess = input.census.inProcessSessions ?? 0
  // In-process terminals cannot survive restart; force cannot override a counted one, with or without a daemon.
  if (inProcess > 0) {
    return {
      action: 'defer',
      code: 'orcad_update_ends_in_process_terminals',
      reason:
        `${inProcess} terminal${inProcess === 1 ? ' runs' : 's run'} inside the orcad process ` +
        'itself because its terminal daemon is degraded or not running. Any restart ends ' +
        `${inProcess === 1 ? 'it' : 'them'}, and forcing the update cannot keep ` +
        `${inProcess === 1 ? 'it' : 'them'} alive. Close ${inProcess === 1 ? 'it' : 'them'}, ` +
        'then update.'
    }
  }
  const crossing = assessOrcadLiveDaemonCrossing(
    input.census,
    input.candidateDaemonProtocol,
    input.hostDaemonProtocols
  )
  // Force can accept mixed builds, never unreachable terminals.
  if (crossing.state === 'strands-live-terminals') {
    return {
      action: 'defer',
      code: 'orcad_update_strands_live_terminals',
      reason:
        `A terminal daemon on this host speaks ${describeDaemonProtocols(crossing.unattachable)}, ` +
        `which orcad ${input.candidateVersion} cannot attach to. Restarting now would leave ` +
        'any terminals it runs unreachable. Update when no terminals are running.'
    }
  }
  const { liveSessions } = input.census
  // The census answered and the candidate proved every daemon generation dead: no daemon terminal can be stranded.
  if (
    liveSessions === null &&
    input.force === true &&
    input.hostDaemonProtocols?.length === 0 &&
    isAnsweredOrcadTerminalCensus(input.census)
  ) {
    return {
      action: 'proceed',
      preservesLiveDaemon: false,
      notes: [
        input.census.inProcessSessions === 0
          ? 'Forced while no terminal daemon is running and orcad runs no terminals itself.'
          : 'Forced while no terminal daemon is running. This orcad cannot count the terminals ' +
            'it runs itself, and they end with the restart.'
      ]
    }
  }
  // Only an uncounted census the server answered can pass on a later force; a counted one never can.
  const forceable = liveSessions === null && isAnsweredOrcadTerminalCensus(input.census)
  if (input.force && crossing.state === 'unverifiable') {
    return {
      action: 'defer',
      code: 'orcad_update_daemon_protocol_unverifiable',
      ...(forceable ? { forceable: true } : {}),
      reason:
        'The terminal daemon did not report its protocol, so this update cannot show that ' +
        `orcad ${input.candidateVersion} will reach the terminals it is forced past. Retry ` +
        'when the daemon answers or has stopped.'
    }
  }
  if (liveSessions === null) {
    if (input.force !== true) {
      return {
        action: 'defer',
        code: 'orcad_update_terminal_census_unavailable',
        ...(forceable ? { forceable: true } : {}),
        reason:
          'The terminal census did not provide a session count, so Orca cannot tell ' +
          'whether work is running on the host. Retry when the server can count its terminals.'
      }
    }
    return {
      action: 'proceed',
      // Unknown census must preserve possible live sessions; never assume the daemon replaceable.
      preservesLiveDaemon: true,
      notes: [
        'Forced with an unverifiable session count. Planning as if terminals are live: the ' +
          'daemon will be preserved across the restart, and the outgoing version directory ' +
          'stays pinned against GC.'
      ]
    }
  }
  if (liveSessions > 0 && !input.force) {
    return {
      action: 'defer',
      code: 'orcad_update_terminals_running',
      reason:
        `${liveSessions} terminal${liveSessions === 1 ? ' is' : 's are'} running on this host. ` +
        'The restart would not kill them — the daemon is preserved — but the host would run ' +
        `orcad ${input.candidateVersion} against a daemon forked from ` +
        `${input.record.active ?? 'the previous build'} until they all exit. Update when the ` +
        'host is idle, or force it.'
    }
  }
  if (liveSessions > 0) {
    return {
      action: 'proceed',
      preservesLiveDaemon: true,
      notes: [
        `Forced with ${liveSessions} live terminal${liveSessions === 1 ? '' : 's'}. They survive ` +
          'the restart on the existing daemon; the outgoing version directory stays pinned ' +
          'against GC because that daemon was forked from it.'
      ]
    }
  }
  return {
    action: 'proceed',
    // At zero sessions daemon-init can safely replace the old daemon.
    preservesLiveDaemon: false,
    notes: [
      'No terminals are running, so the daemon is replaced by one forked from the new bundle.'
    ]
  }
}
