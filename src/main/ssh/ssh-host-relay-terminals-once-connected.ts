/**
 * A connect decides its server before any relay session exists, so a lease this desktop left
 * detached reads unverifiable then: nothing can be asked. Once the relay session is up, the relay
 * holding the PTY answers, and a terminal it still runs is reported live. On Windows, where the
 * host's relay endpoints cannot be listed, this is the only way that answer is ever heard.
 */
import type { Store } from '../persistence'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'
import {
  assessOrcadMigrationTerminals,
  retireProvenExitedLeases,
  terminalsRunElsewhere,
  type CensusHostRelayTerminals,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'

type RelayDecision = Extract<HostServerOnConnectResult, { route: 'relay' }>

/** The live decision the connected relay proves, or null when the first decision stands. */
export async function relayTerminalsOnceConnected(args: {
  store: Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>
  targetId: string
  decision: HostServerOnConnectResult | null
  listRelayPtyIds: ListRelayPtyIds | null
  /** Every relay on the account; only it proves the leases' terminals exited, not just ours. */
  censusHost: CensusHostRelayTerminals
  /** False once the connect was cancelled: it must neither report nor retire anything. */
  isCurrent: () => boolean
}): Promise<RelayDecision | null> {
  // A live decision is re-counted too: before a session only leases could be counted, and the
  // relay's own listing also holds shells this desktop never leased.
  if (
    args.decision?.route !== 'relay' ||
    (args.decision.reason !== 'relay_terminals_unverifiable' &&
      args.decision.reason !== 'relay_terminals_live') ||
    !args.listRelayPtyIds
  ) {
    return null
  }
  const proof = await assessOrcadMigrationTerminals(
    args.store,
    args.targetId,
    args.listRelayPtyIds,
    args.censusHost
  )
  if (!args.isCurrent()) {
    return null
  }
  if (proof.verdict === 'live') {
    return {
      route: 'relay',
      reason: 'relay_terminals_live',
      terminals: proof.ptyIds.length || (proof.hostTerminals ?? 0),
      ...(terminalsRunElsewhere(proof) ? { terminalsElsewhere: true } : {})
    }
  }
  // This connect already runs the relay; retiring proven leases lets the next one convert, where
  // leaving them would read unverifiable on every connect, since nothing can ask before a session.
  retireProvenExitedLeases(args.store, args.targetId, proof)
  return null
}
