import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'

export const LEGACY_SOURCE_REFUSALS = [
  'source-inventory',
  'source-recovery',
  'source-orphan',
  'source-queue',
  'source-queued-only-v1',
  'source-corrupt',
  'source-newer'
] as const
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
