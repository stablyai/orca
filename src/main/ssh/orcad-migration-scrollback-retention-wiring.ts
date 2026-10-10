import type { Store } from '../persistence'
import {
  listOrcadMigrationSourceCutovers,
  setOrcadMigrationJournalChangeListener
} from './orcad-migration-cutover-journal'

/** Keeps the store's scrollback retention in step with the journal, from startup on. */
export function installOrcadMigrationScrollbackRetention(
  userDataPath: string,
  store: Pick<Store, 'syncOrcadMigrationScrollbackRetention'>
): void {
  const sync = (path: string): void => {
    try {
      // Held until the destination has the bytes; committed or abandoned migrations release them.
      const pending = listOrcadMigrationSourceCutovers(path).filter(
        (cutover) => cutover.phase === 'source-fenced' || cutover.phase === 'destination-staged'
      )
      store.syncOrcadMigrationScrollbackRetention(pending.map((cutover) => cutover.manifest))
    } catch (error) {
      // An unreadable journal keeps whatever is held; releasing on a guess could lose bytes.
      console.warn('[orcad-migration] Could not sync scrollback retention:', error)
    }
  }
  setOrcadMigrationJournalChangeListener(sync)
  sync(userDataPath)
}
