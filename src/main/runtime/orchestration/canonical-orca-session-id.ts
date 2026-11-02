import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/** Address by the /clear root to preserve Runs and mail; without records, retain the supplied id. */
export function canonicalOrcaSessionId(
  orcaSessionId: OrcaSessionId,
  store: Pick<
    AgentSessionRecordReader,
    'listRecords' | 'revision'
  > | null = readAgentSessionRecordStore()
): OrcaSessionId {
  return createCanonicalOrcaSessionResolver(store)(orcaSessionId)
}

/** Clear edges per store revision: mail checks ask per message, and must not rescan every record each time. */
const clearEdgesByRevision = new WeakMap<object, ReadonlyMap<string, string>>()

export function createCanonicalOrcaSessionResolver(
  store: Pick<AgentSessionRecordReader, 'listRecords' | 'revision'> | null
): (id: OrcaSessionId) => OrcaSessionId {
  if (!store) {
    return (id) => id
  }
  const revision = store.revision?.()
  let clearedFrom = revision ? clearEdgesByRevision.get(revision) : undefined
  if (!clearedFrom) {
    const edges = new Map<string, string>()
    for (const record of store.listRecords()) {
      const next = clearedInto(record)
      if (next) {
        edges.set(next, record.sessionId)
      }
    }
    clearedFrom = edges
    if (revision) {
      clearEdgesByRevision.set(revision, edges)
    }
  }
  const edges = clearedFrom
  return (id) => canonicalOrcaSessionFromEdges(id, edges)
}

export function canonicalOrcaSessionFromEdges(
  orcaSessionId: OrcaSessionId,
  clearedFrom: ReadonlyMap<string, string>
): OrcaSessionId {
  // The visited set bounds corrupt chains; valid clear lineage is acyclic.
  let root: string = orcaSessionId
  const earlier = new Set([root])
  let prior = clearedFrom.get(root)
  while (prior && !earlier.has(prior)) {
    earlier.add(prior)
    root = prior
    prior = clearedFrom.get(root)
  }
  // Record ids are minted as Orca session ids; one that is not cannot name the conversation.
  return isOrcaSessionId(root) ? root : orcaSessionId
}
