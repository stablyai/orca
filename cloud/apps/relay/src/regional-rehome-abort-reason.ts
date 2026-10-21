import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'

// Why an attempt was rolled back to its source. Attempts settled by the
// migration-side abort paths, and every row aborted before the column existed,
// leave it null.
export const REGIONAL_REHOME_ABORT_REASONS = ['host_not_arrived', 'max_refresh_expired'] as const

export type RegionalRehomeAbortReason = (typeof REGIONAL_REHOME_ABORT_REASONS)[number]

// One whole migration lease with the host absent from the target and owning
// nothing on the source. Nothing legitimately takes that long: the attach
// deadline is seconds, and a host that is still moving holds a lease at one end
// or the other. The control's `drain_grace_ms` does not fit — idle rehome
// commits with a grace of zero, so these attempts never carry one.
export const REGIONAL_REHOME_ARRIVAL_WINDOW_MS = ASSIGNMENT_LIMITS.migrationLeaseMs

// The window the inventory line and the preview both report aborts over.
export const REGIONAL_REHOME_ABORT_REPORT_WINDOW_MS = 24 * 60 * 60_000
