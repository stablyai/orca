import { lstatSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, rm, writeFile } from 'node:fs/promises'
import { readHooksJsonWithRaw, type HooksConfig } from '../agent-hooks/installer-utils'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import { isOrcaOwnedRemnant, removeManagedGrokHookEntries } from './grok-hook-config-cleanup'
import { readGrokHookConfigSnapshot } from './grok-hook-config-file'
import { getGrokManagedScriptFileName } from './grok-hook-script'

type BackupAction = { kind: 'delete' } | { kind: 'rewrite'; contents: string } | null

/** Our writes keep a rolling `.bak` of the hook file, which still names Orca's script after
 * removal: delete it when only Orca's entries were in it, otherwise strip just those. */
function backupAction(config: HooksConfig | null, raw: string | null): BackupAction {
  if (!config || raw === null) {
    return null
  }
  const cleanup = removeManagedGrokHookEntries(config, getGrokManagedScriptFileName())
  if (isOrcaOwnedRemnant(cleanup.config)) {
    return { kind: 'delete' }
  }
  return cleanup.removedAny
    ? { kind: 'rewrite', contents: `${JSON.stringify(cleanup.config, null, 2)}\n` }
    : null
}

function warnUnlessMissing(error: unknown): void {
  if (!hasErrorCode(error, 'ENOENT')) {
    console.warn('[grok] could not clean the hook backup:', error)
  }
}

export function removeGrokHookBackupEntries(configPath: string): void {
  const backup = `${configPath}.bak`
  try {
    if (lstatSync(backup).isSymbolicLink()) {
      return
    }
    const snapshot = readHooksJsonWithRaw(backup)
    const action = backupAction(snapshot.config, snapshot.raw)
    if (action?.kind === 'delete') {
      rmSync(backup, { force: true })
    } else if (action?.kind === 'rewrite') {
      writeFileSync(backup, action.contents)
    }
  } catch (error) {
    warnUnlessMissing(error)
  }
}

/** The quit path's variant: no synchronous fs calls. */
export async function removeGrokHookBackupEntriesAsync(configPath: string): Promise<void> {
  const backup = `${configPath}.bak`
  try {
    if ((await lstat(backup)).isSymbolicLink()) {
      return
    }
    const snapshot = await readGrokHookConfigSnapshot(backup)
    const action = backupAction(snapshot.config, snapshot.raw)
    if (action?.kind === 'delete') {
      await rm(backup, { force: true })
    } else if (action?.kind === 'rewrite') {
      await writeFile(backup, action.contents)
    }
  } catch (error) {
    warnUnlessMissing(error)
  }
}
