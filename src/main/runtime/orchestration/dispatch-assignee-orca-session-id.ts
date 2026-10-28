import { parseOrcaSessionAddress, type OrcaSessionId } from '../../../shared/orca-session-address'
import { structuredWorkerOrcaSessionIdForIncarnation } from '../structured-worker-identity'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'

/** Resolve structured incarnations or chat addresses to bare session ids; PTYs have none. */
export function dispatchAssigneeOrcaSessionId(assignee: {
  handle: string
  processIncarnation: string | null | undefined
}): OrcaSessionId | null {
  const orcaSessionId =
    structuredWorkerOrcaSessionIdForIncarnation(assignee.processIncarnation) ??
    parseOrcaSessionAddress(assignee.handle)
  return orcaSessionId === null ? null : canonicalOrcaSessionId(orcaSessionId)
}
