import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { skillDeleteJournalPath } from '../skill-delete/recovery'
import { skillInstallReceiptPath } from '../skill-install-provenance'
import { skillInstallJournalPath } from '../skill-install-recovery'
import { skillPlacementJournalPath } from '../skill-placement-recovery-journal'
import { skillRemovalJournalPath } from '../skill-remove-recovery'

// What cloud skill sharing left at a path: a pending transaction, or a receipt for its package.
async function anyFileExists(paths: readonly string[]): Promise<boolean> {
  const found = await Promise.all(
    paths.map((path) =>
      lstat(path).then(
        () => true,
        () => false
      )
    )
  )
  return found.includes(true)
}

/** Cloud installs key state on the realpath'd destination, so check both spellings. */
export function stateKeysFor(path: string, realPath: string): string[] {
  return [...new Set([resolve(path), realPath])]
}

export function hasPendingCloudTransaction(stateDirectory: string, keys: readonly string[]) {
  return anyFileExists(
    keys.flatMap((key) => [
      skillInstallJournalPath(stateDirectory, key),
      skillPlacementJournalPath(stateDirectory, key),
      skillRemovalJournalPath(stateDirectory, key),
      skillDeleteJournalPath(stateDirectory, key)
    ])
  )
}

export function hasCloudReceipt(stateDirectory: string, keys: readonly string[]) {
  return anyFileExists(keys.map((key) => skillInstallReceiptPath(stateDirectory, key)))
}
