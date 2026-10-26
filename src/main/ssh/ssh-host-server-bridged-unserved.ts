/** COMPAT(legacy-relay-bridge, revisit 2027-01-15): keep blocked same-checkout relinks connected/unmoved while old tabs still need bridged terminals. Reconnect after exit can link the server's existing project. */
import type { SshManagedServerRelayReason } from '../../shared/ssh-types'
import type {
  HostServerOnConnectResult,
  HostServerTerminalVerdict
} from './ssh-host-server-on-connect'
import { isBridgedTerminalLinkConflict } from './orcad-migration-conflict-guidance'

export function relayTerminalReason(verdict: 'live' | 'unverifiable'): SshManagedServerRelayReason {
  return verdict === 'live' ? 'relay_terminals_live' : 'relay_terminals_unverifiable'
}

/** `failed` is the conversion's refusal after its fence was released; a held move never qualifies. */
export function keptForBridgedTerminals(
  failed: HostServerOnConnectResult,
  terminals: HostServerTerminalVerdict | null,
  error: unknown
): HostServerOnConnectResult {
  if (
    !terminals?.bridged ||
    terminals.verdict === 'exited' ||
    failed.route !== 'unserved' ||
    failed.reason !== 'refused' ||
    failed.held ||
    !isBridgedTerminalLinkConflict(error)
  ) {
    return failed
  }
  return {
    ...failed,
    reason: relayTerminalReason(terminals.verdict),
    terminals: terminals.count,
    bridged: true
  }
}
