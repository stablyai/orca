import type { Store } from '../persistence'
import {
  listOrcadMigrationSourceCutovers,
  setOrcadMigrationJournalChangeListener
} from './orcad-migration-cutover-journal'

export function installOrcadMigrationScrollbackRetention(
  userDataPath: string,
  store: Pick<Store, 'syncOrcadMigrationScrollbackRetention'>
): void {
  const sync = (path: string): void => {
    try {
      // Retain bytes until durable commit/abort; closed tabs must still upload on retry.
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
