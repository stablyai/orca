import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { CODEX_DATABASE_FILE, withManifestLock } from './codex-account-history-cleanup-manifest'

/**
 * Moves the home's own Codex databases into `holding`, under the manifest's lock so a cleanup
 * deleting them as unused never sees half of them moved. False when any stayed behind.
 */
export async function setAsideCodexDatabases(
  accountHome: string,
  holding: string,
  onWarning: (error: unknown) => void
): Promise<boolean> {
  let complete = true
  await withManifestLock(accountHome, async () => {
    const entries = await readdir(accountHome, { withFileTypes: true }).catch((error: unknown) => {
      if (isDefinitiveAbsence(error)) {
        return []
      }
      throw error
    })
    for (const entry of entries) {
      if (!entry.isFile() || !CODEX_DATABASE_FILE.test(entry.name)) {
        continue
      }
      try {
        await mkdir(holding, { recursive: true })
        await rename(join(accountHome, entry.name), join(holding, entry.name))
      } catch (error) {
        complete = false
        onWarning(error)
      }
    }
  }).catch((error: unknown) => {
    complete = false
    onWarning(error)
  })
  return complete
}
