import {
  RESOURCE_RESERVATION_CONFLICT_ERROR,
  type ResourceReservationKind
} from '../../shared/resource-reservation-binding'

/** Reusing a single-use reservation key against a different binding. Distinct from a retryable
 *  transport failure: the caller's ledger, not the connection, is what disagrees. */
export class ResourceReservationConflictError extends Error {
  readonly code = RESOURCE_RESERVATION_CONFLICT_ERROR
  constructor(
    message: string,
    readonly data: { resourceKind: ResourceReservationKind; resourceId: string }
  ) {
    super(message)
    this.name = 'ResourceReservationConflictError'
  }
}
