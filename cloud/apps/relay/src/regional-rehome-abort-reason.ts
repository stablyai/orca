import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'

// Why an attempt was rolled back to its source. Attempts settled by the
// migration-side abort paths, and every row aborted before the column existed,
// leave it null.
export const REGIONAL_REHOME_ABORT_REASONS = ['host_not_arrived', 'max_refresh_expired'] as const

export type RegionalRehomeAbortReason = (typeof REGIONAL_REHOME_ABORT_REASONS)[number]

// One migration lease with neither target arrival nor source ownership proves abandonment; attach takes seconds. Drain grace cannot bound idle rehomes, which commit with zero grace.
export const REGIONAL_REHOME_ARRIVAL_WINDOW_MS = ASSIGNMENT_LIMITS.migrationLeaseMs

// The window the inventory line and the preview both report aborts over.
export const REGIONAL_REHOME_ABORT_REPORT_WINDOW_MS = 24 * 60 * 60_000
