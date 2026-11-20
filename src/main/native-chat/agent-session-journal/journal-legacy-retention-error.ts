import { LEGACY_JOURNAL_RETIREMENT_REASONS } from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'

/** Shared with telemetry, which reports a refusal by this reason alone. */
export const LEGACY_SOURCE_REFUSALS = LEGACY_JOURNAL_RETIREMENT_REASONS
export type LegacySourceRefusalReason = (typeof LEGACY_SOURCE_REFUSALS)[number]

/** Only proven frozen-source facts can survive a database owner. */
export class JournalLegacyRetentionError extends Error {
  constructor(
    message: string,
    readonly reason?: LegacySourceRefusalReason
  ) {
    super(message)
  }
}

/** Unsupported storage is stable for this owner/descriptor, not across opens. */
export class JournalLegacyIneligibleError extends JournalLegacyRetentionError {}

export function readJournalLegacySource<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (isSqliteCorruption(error)) {
      throw new JournalLegacyRetentionError('legacy source is corrupt', 'source-corrupt')
    }
    throw error
  }
}
