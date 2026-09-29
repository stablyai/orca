import type { OrcaSessionId } from '../../../shared/orca-session-address'

/** The Orca session id orchestration addresses a session by; every session-to-party step calls this. */
export function canonicalOrcaSessionId(orcaSessionId: OrcaSessionId): OrcaSessionId {
  // Later lineage canonicalization (a `/clear`ed session to its lineage root) plugs in here.
  return orcaSessionId
}
