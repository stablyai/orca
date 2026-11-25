import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { skillDeleteJournalPath } from '../skill-delete/skill-delete-recovery'
import { skillInstallReceiptPath } from '../transaction-state/skill-install-provenance'
import { skillInstallJournalPath } from '../install/skill-install-recovery'
import { skillPlacementJournalPath } from '../provider-placement/skill-placement-recovery-journal'
import { skillRemovalJournalPath } from '../managed-remove/skill-remove-recovery'

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
