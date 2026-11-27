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
    /** Which shapes builds left behind the inventory saw; set only by inventory refusals. */
    readonly artifact?: LegacySourceArtifact
  ) {
    super(message)
  }
}

/**
 * Shapes builds left behind that the inventory saw, named so a refusal can be counted by them: an
 * hourly build of 2026-10-05/06 added queued_messages.source_json, and v1.4.219 kept Stop pauses in
 * queued_message_pauses.
 */
export const LEGACY_SOURCE_ARTIFACTS = ['none', 'source_json', 'pause_table', 'both'] as const
export type LegacySourceArtifact = (typeof LEGACY_SOURCE_ARTIFACTS)[number]

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
  extraColumns: readonly string[],
  artifact: LegacySourceArtifact
): JournalLegacyRetentionError {
  return new JournalLegacyRetentionError(
    extraColumns.length > 0
      ? 'legacy source has unaccounted columns'
      : 'legacy source has an unknown table',
    'source-inventory',
    artifact
  )
}

/** The original holds rows in a table no shipped reader accounts for. */
export function legacyRecoveryRefusal(artifact: LegacySourceArtifact): JournalLegacyRetentionError {
  return new JournalLegacyRetentionError(
    'legacy source has unaccounted recovery data',
    'source-recovery',
    artifact
  )
}
