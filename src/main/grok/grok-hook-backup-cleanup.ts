import { lstatSync, rmSync, writeFileSync } from 'node:fs'
import { readHooksJsonWithRaw } from '../agent-hooks/installer-utils'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import { isOrcaOwnedRemnant, removeManagedGrokHookEntries } from './grok-hook-config-cleanup'
import { getGrokManagedScriptFileName } from './grok-hook-script'

/** Our writes keep a rolling `.bak` of the hook file, which still names Orca's script after
 * removal: delete it when only Orca's entries were in it, otherwise strip just those. */
export function removeGrokHookBackupEntries(configPath: string): void {
  const backup = `${configPath}.bak`
  try {
    if (lstatSync(backup).isSymbolicLink()) {
      return
    }
    const snapshot = readHooksJsonWithRaw(backup)
    if (!snapshot.config || snapshot.raw === null) {
      return
    }
    const cleanup = removeManagedGrokHookEntries(snapshot.config, getGrokManagedScriptFileName())
    if (isOrcaOwnedRemnant(cleanup.config)) {
      rmSync(backup, { force: true })
    } else if (cleanup.removedAny) {
      writeFileSync(backup, `${JSON.stringify(cleanup.config, null, 2)}\n`)
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      console.warn('[grok] could not clean the hook backup:', error)
    }
  }
}
