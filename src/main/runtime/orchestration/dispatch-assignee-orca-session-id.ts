import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { structuredWorkerOrcaSessionIdForIncarnation } from '../structured-worker-identity'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'

/** The Orca session id a Dispatch row stores for the structured worker a process incarnation names. */
export function dispatchAssigneeOrcaSessionId(
  processIncarnation: string | null | undefined
): OrcaSessionId | null {
  const orcaSessionId = structuredWorkerOrcaSessionIdForIncarnation(processIncarnation)
  return orcaSessionId === null ? null : canonicalOrcaSessionId(orcaSessionId)
}
