import { parseOrchestrationPrincipal } from '../../../../shared/orchestration-principal'
import { isEquivalentPaneKey } from './pane-key-match'

/**
 * Equivalence over serialized `OrchestrationPrincipal` strings.
 *
 * INVARIANT: cross-kind is NEVER equivalent, in either direction. A structured pane key's tab half
 * embeds the session id in plain text (`structured-agent-session-<sessionId>:<leaf>`), so deriving
 * `session:` from `pane:` here would let anyone who learns a session id fabricate a "matching"
 * pane key and reach the coordinator's Run binding through caller-supplied-pane-key paths. That
 * derivation is legal exactly once — PR 1's one-time server-side backfill/dual-write over pane
 * keys the host itself wrote (`principalFromPaneKey`) — and never at request/match time: the
 * random leaf is the only real credential. The backfill rule does NOT generalize to matching.
 */
export function isEquivalentPrincipal(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  const aParsed = parseOrchestrationPrincipal(a)
  const bParsed = parseOrchestrationPrincipal(b)
  // Session principals match exactly (handled above); unparseable or cross-kind never match.
  if (aParsed?.kind !== 'pane' || bParsed?.kind !== 'pane') {
    return false
  }
  // Leaf-UUID rule preserved so break-out remints keep matching.
  return isEquivalentPaneKey(aParsed.paneKey, bParsed.paneKey)
}
