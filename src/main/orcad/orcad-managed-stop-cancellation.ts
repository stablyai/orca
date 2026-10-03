/** Withdrawing a managed stop request that the running orcad has not acted on yet. */
import { rmSync } from 'node:fs'
import type {
  OrcadManagedStopCancellation,
  OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { claimOrcadManagedStopDecision } from './orcad-managed-stop-decision'
import {
  orcadManagedStopRequestPath,
  readOrcadManagedStopRequest
} from './orcad-managed-stop-request'

/** `dispatched` means orcad already began stopping; only its completion can say how it ended. */
export function cancelOrcadManagedStop(
  request: OrcadManagedStopRequest
): OrcadManagedStopCancellation['outcome'] {
  const outcome = claimOrcadManagedStopDecision(request, 'canceled')
  if (outcome === 'canceled') {
    removePendingRequest(request)
  }
  return outcome
}

/** Removes the request file only while it still carries this transaction. */
function removePendingRequest(request: OrcadManagedStopRequest): void {
  const path = orcadManagedStopRequestPath(request.instance)
  try {
    if (readOrcadManagedStopRequest(path).transactionId === request.transactionId) {
      rmSync(path, { force: true })
    }
  } catch {
    // Absent or another transaction's request: the standing decision already fences this one.
  }
}
