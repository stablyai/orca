import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import {
  clearLineageFromNewest,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/**
 * The Orca session id orchestration addresses a session by: the first session of its `/clear`
 * lineage, so a cleared chat keeps the address, Runs and mail it had. Every session-to-party step
 * calls this. Without a record store there is no lineage to read, and the id stands for itself.
 */
export function canonicalOrcaSessionId(
  orcaSessionId: OrcaSessionId,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): OrcaSessionId {
  if (!store) {
    return orcaSessionId
  }
  const root = clearLineageFromNewest(store, orcaSessionId).at(-1) ?? orcaSessionId
  // Record ids are minted as Orca session ids; one that is not cannot name the conversation.
  return isOrcaSessionId(root) ? root : orcaSessionId
}
