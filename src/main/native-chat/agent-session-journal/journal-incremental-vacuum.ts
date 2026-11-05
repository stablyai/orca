import type { JournalHostDatabase } from './journal-host-database'

const remainingPages = new WeakMap<object, number>()

/** Captured page work cannot grow with concurrent writers; older files keep reusable free space. */
export async function vacuumJournalPage(
  database: Pick<JournalHostDatabase, 'scan' | 'maintenance'>,
  charge: (ms: number) => void = () => {}
): Promise<boolean> {
  let remaining = remainingPages.get(database)
  if (remaining === undefined) {
    remaining = await database.scan(async (read) => {
      const started = performance.now()
      try {
        const mode = (await read.prepare('PRAGMA auto_vacuum').get())?.auto_vacuum
        const free =
          mode === 2 ? (await read.prepare('PRAGMA freelist_count').get())?.freelist_count : 0
        return typeof free === 'number' ? free : 0
      } finally {
        charge(performance.now() - started)
      }
    })
  }
  if (remaining <= 0) {
    remainingPages.delete(database)
    return false
  }
  const result = await database.maintenance({ kind: 'vacuum', pages: remaining })
  charge(result.elapsed)
  const more = result.valid && result.more && remaining > result.steps
  if (more) {
    remainingPages.set(database, remaining - result.steps)
  } else {
    remainingPages.delete(database)
  }
  return more
}
