import type { JournalHostDatabase } from './journal-host-database'

/** Older files reuse freed pages; converting them would require a full rewrite. */
export async function vacuumJournalPage(
  database: Pick<JournalHostDatabase, 'maintenance'>,
  charge: (ms: number) => void = () => {}
): Promise<boolean> {
  const result = await database.maintenance({ kind: 'vacuum' })
  charge(result.elapsed)
  return result.more
}
