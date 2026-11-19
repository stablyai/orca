import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { removeStagedCopy } from '../rollouts/codex-rollout-staged-copy'

const STAGED_IMPORT = /^\.orca-import-[^-]+-.+\.tmp$/

/** The file naming the copy the import is staging, so one a quit left behind is removed. */
export function stagingRecordPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'import-staging.txt')
}

/** Records the staged copy in progress, or that none is (`null`). */
export async function recordStagedImport(recordPath: string, staged: string | null): Promise<void> {
  if (staged === null) {
    await rm(recordPath, { force: true })
    return
  }
  await mkdir(dirname(recordPath), { recursive: true })
  await writeFile(recordPath, staged)
}

/**
 * Removes the staged copy an earlier import left when Orca quit or crashed mid-copy. One import
 * runs per profile, so none is still live; this works whether or not its folder is listed again.
 */
export async function removeAbandonedStagedImport(recordPath: string): Promise<void> {
  let staged: string
  try {
    staged = (await readFile(recordPath, 'utf8')).trim()
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw error
  }
  if (STAGED_IMPORT.test(basename(staged))) {
    await removeStagedCopy(staged)
  }
  await recordStagedImport(recordPath, null)
}
