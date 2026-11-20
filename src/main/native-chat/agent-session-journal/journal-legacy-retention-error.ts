import { LEGACY_JOURNAL_RETIREMENT_REASONS } from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'

/** Shared with telemetry, which reports a refusal by this reason alone. */
export const LEGACY_SOURCE_REFUSALS = LEGACY_JOURNAL_RETIREMENT_REASONS
export type LegacySourceRefusalReason = (typeof LEGACY_SOURCE_REFUSALS)[number]

/** Only proven frozen-source facts can survive a database owner. */
export class JournalLegacyRetentionError extends Error {
  constructor(
    message: string,
    readonly reason?: LegacySourceRefusalReason,
    /** A shape builds left behind that this refusal saw, reported by name only. */
    readonly artifact?: LegacySourceArtifact
  ) {
    super(message)
  }
}

export type LegacySourceArtifact = 'source_json' | 'pause_table'

/**
 * Shapes builds left behind, named so a refusal can be counted by them: an hourly build of
 * 2026-10-05/06 added queued_messages.source_json, and builds of 2026-09-29 to 10-01 (v1.4.219)
 * kept Stop pauses in queued_message_pauses.
 */
function legacySourceArtifact(
  table: string,
  extraColumns: readonly string[]
): LegacySourceArtifact | undefined {
  if (table === 'queued_message_pauses') {
    return 'pause_table'
  }
  return table === 'queued_messages' &&
    extraColumns.length > 0 &&
    extraColumns.every((name) => name === 'source_json')
    ? 'source_json'
    : undefined
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

/** The original has columns no shipped reader accounts for. */
export function legacyInventoryRefusal(
  table: string,
  extraColumns: readonly string[]
): JournalLegacyRetentionError {
  return new JournalLegacyRetentionError(
    extraColumns.length > 0
      ? 'legacy source has unaccounted columns'
      : 'legacy source has an unknown table',
    'source-inventory',
    legacySourceArtifact(table, extraColumns)
  )
}

/** The original holds rows in a table no shipped reader accounts for. */
export function legacyRecoveryRefusal(table: string): JournalLegacyRetentionError {
  return new JournalLegacyRetentionError(
    'legacy source has unaccounted recovery data',
    'source-recovery',
    legacySourceArtifact(table, [])
  )
}
