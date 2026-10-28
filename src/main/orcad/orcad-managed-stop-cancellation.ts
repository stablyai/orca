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

/** Dispatched stops cannot be canceled; their completion verdict remains authoritative. */
export function cancelOrcadManagedStop(
  request: OrcadManagedStopRequest
): OrcadManagedStopCancellation['outcome'] {
  const outcome = claimOrcadManagedStopDecision(request, 'canceled')
  if (outcome === 'canceled') {
    withdrawOrcadManagedStopRequest(request)
  }
  return outcome
}

export function withdrawOrcadManagedStopRequest(request: OrcadManagedStopRequest): void {
  const path = orcadManagedStopRequestPath(request.instance)
  try {
    if (readOrcadManagedStopRequest(path).transactionId === request.transactionId) {
      rmSync(path, { force: true })
    }
  } catch {
    // The persisted decision fences this transaction even if its request is gone.
  }
}
