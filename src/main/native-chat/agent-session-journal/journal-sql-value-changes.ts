import type { JournalEntryChange } from './journal-transition-collections'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'

/** Collection access order and key reinsertions determine the saved outcome order. */
export class JournalSqlValueChanges {
  readonly accessed = new Set<string>()
  private readonly pending = new Map<
    string,
    { location: JournalSqlValueLocation; reinsert: boolean }
  >()

  touch(location: JournalSqlValueLocation, reinsert: boolean, deleted: boolean): void {
    const key = JSON.stringify([location.collection, location.key])
    if (reinsert) {
      this.pending.delete(key)
    }
    const before = this.pending.get(key)
    this.pending.set(key, { location, reinsert: deleted ? false : reinsert || !!before?.reinsert })
  }

  read(context: JournalSqlValueContext, reset: boolean): JournalEntryChange[] {
    const entries = [...this.pending.values()]
    const changes = [...this.accessed]
      .flatMap((collection) => entries.filter((entry) => entry.location.collection === collection))
      .map(({ location, reinsert }) => {
        const present = !!context.header(location.collection, location.key)
        return {
          path: location.collection,
          key: JSON.parse(location.key),
          deleted: !present,
          reinsert,
          value: context.read(location.collection, location.key)
        }
      })
    if (reset) {
      this.pending.clear()
    }
    return changes
  }
}
