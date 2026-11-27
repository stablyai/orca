import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'

export const LEGACY_IMPORT_BLOCK_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }
// Keep only recent history in memory; the provider resumes the complete source transcript.
export const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024
