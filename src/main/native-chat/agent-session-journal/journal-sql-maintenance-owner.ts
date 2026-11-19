import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlActivity } from './journal-sql-activity'

/**
 * One background owner per store. A writable store's owner also retires its original journal
 * (`legacySource` is its state directory) between units, at the same idle boundary and pacing.
 */
export function createJournalSqlMaintenance(
  writer: Pick<JournalSqlOwner, 'maintain'>,
  readers: JournalSqlReaderPool,
  conversions: Pick<JournalSqlConversions, 'ensure' | 'compareLegacyChats'>,
  activity: JournalSqlActivity,
  options: {
    onMaintenanceError: (error: unknown, sessionId?: string) => void
    onMaintenanceTick?: () => void
  },
  legacySource: string | null
): JournalSqlBackgroundMaintenance {
  const maintenance = new JournalSqlBackgroundMaintenance(
    writer,
    readers,
    conversions,
    activity,
    options.onMaintenanceError,
    options.onMaintenanceTick
  )
  if (legacySource !== null) {
    const retirement = new JournalLegacyRetirement(
      legacySource,
      writer,
      readers,
      // A conversion the proof waits on keeps periodic cleanup running, as idle conversion does.
      { ensure: (id, foreground) => maintenance.serviceWhile(conversions.ensure(id, foreground)) },
      () => maintenance.boundary(),
      options.onMaintenanceError,
      undefined,
      undefined,
      (started) => maintenance.rest(started)
    )
    maintenance.stopped.signal.addEventListener('abort', () => retirement.stop(), { once: true })
    maintenance.legacy = retirement
  }
  return maintenance
}
