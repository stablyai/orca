import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

type CanonicalLineage = { predecessors: Map<string, string>; roots: Map<string, OrcaSessionId> }
const publishedLineages = new WeakMap<ReadonlyMap<string, AgentSessionRecord>, CanonicalLineage>()

function buildLineage(records: Iterable<AgentSessionRecord>): CanonicalLineage {
  const predecessors = new Map<string, string>()
  for (const record of records) {
    const next = clearedInto(record)
    if (next) {
      predecessors.set(next, record.sessionId)
    }
  }
  return { predecessors, roots: new Map() }
}

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
  const snapshot = store.getRecordSnapshot?.()
  let lineage = snapshot ? publishedLineages.get(snapshot) : undefined
  if (!lineage) {
    lineage = buildLineage(snapshot ? snapshot.values() : store.listRecords())
    if (snapshot) {
      publishedLineages.set(snapshot, lineage)
    }
  }
  let root: string = orcaSessionId
  const path = new Set<string>()
  for (;;) {
    const known = lineage.roots.get(root)
    if (known) {
      root = known
      break
    }
    path.add(root)
    const prior = lineage.predecessors.get(root)
    if (!prior) {
      break
    }
    // Corrupt cycles have start-dependent answers; never compress them.
    if (path.has(prior)) {
      return isOrcaSessionId(root) ? root : orcaSessionId
    }
    root = prior
  }
  if (!isOrcaSessionId(root)) {
    return orcaSessionId
  }
  for (const node of path) {
    // Unknown caller strings must not grow a snapshot's retained memo.
    if (lineage.predecessors.has(node)) {
      lineage.roots.set(node, root)
    }
  }
  return root
}
