import {
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../addressing/session-lineage/structured-session-lineage'
import { OrchestrationError } from '../orchestration-error'

type LineageStore = Pick<AgentSessionRecordReader, 'getRecord' | 'listRecords' | 'lineageRevision'>

/** A chat's workers are recorded under its /clear root (a bot's Home Chat keeps one across clears),
 *  so the dock reads that root for whichever session of the lineage is on screen. Memory only. */
export function workerDockSourceOfSession(
  sessionId: string,
  store: LineageStore | null = readAgentSessionRecordStore()
): string {
  return isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId, store) : sessionId
}

export function workerDockSession(
  party: string,
  store: LineageStore | null = readAgentSessionRecordStore()
): string {
  const session = parseOrcaSessionAddress(party)
  if (!session) {
    throw new OrchestrationError('invalid_argument', 'A worker dock needs a source session.')
  }
  return workerDockSourceOfSession(session, store)
}

/** The source's session and the sessions /clear continued it into, any of which a pane may show. */
export function workerDockSourceSessions(
  source: string,
  store: LineageStore | null = readAgentSessionRecordStore()
): string[] {
  const sessions = [source]
  const record = (id: string) => {
    try {
      return store?.getRecord(id) ?? null
    } catch {
      return null
    }
  }
  for (let next = record(source); next; ) {
    const successor = clearedInto(next)
    if (!successor || sessions.includes(successor)) {
      break
    }
    sessions.push(successor)
    next = record(successor)
  }
  return sessions
}
