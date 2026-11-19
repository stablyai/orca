import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { removeStagedCopy } from '../rollouts/codex-rollout-staged-copy'

const STAGED_IMPORT = /^\.orca-import-[^-]+-.+\.tmp$/
// Staged copies that couldn't be removed accumulate here only while removals keep failing.
const MAX_RECORDED = 32

/** Names staged copies not yet known to be gone, so one a quit or failed removal left is removed. */
export function stagingRecordPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'import-staging.txt')
}

async function readRecord(recordPath: string): Promise<string[]> {
  try {
    return (await readFile(recordPath, 'utf8')).split('\n').filter(Boolean)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

async function writeRecord(recordPath: string, staged: string[]): Promise<void> {
  if (staged.length === 0) {
    await rm(recordPath, { force: true })
    return
  }
  await mkdir(dirname(recordPath), { recursive: true })
  await writeFile(recordPath, `${staged.join('\n')}\n`)
}

/** Records a copy about to be staged, before any of it exists. */
export async function recordStagedImport(recordPath: string, staged: string): Promise<void> {
  const recorded = [...(await readRecord(recordPath)), staged]
  const dropped = recorded.splice(0, Math.max(0, recorded.length - MAX_RECORDED))
  if (dropped.length > 0) {
    console.warn('[codex-history-import] Forgetting staged copies that never went:', dropped)
  }
  await writeRecord(recordPath, recorded)
}

/** Forgets a staged copy once it is gone; one still there stays recorded for the next import. */
export async function forgetStagedImport(recordPath: string, staged: string): Promise<void> {
  try {
    if (await lstatIfPresent(staged)) {
      return
    }
    await writeRecord(
      recordPath,
      (await readRecord(recordPath)).filter((path) => path !== staged)
    )
  } catch (error) {
    console.warn('[codex-history-import] Could not update the staging record:', error)
  }
}

/**
 * Removes the staged copies an earlier import left (Orca quit mid-copy, or a removal failed). One
 * import runs per profile, so none is live; this works whether or not its folder is listed again.
 */
export async function removeAbandonedStagedImports(recordPath: string): Promise<void> {
  const left: string[] = []
  for (const staged of await readRecord(recordPath)) {
    if (!STAGED_IMPORT.test(basename(staged))) {
      continue
    }
    try {
      await removeStagedCopy(staged)
    } catch (error) {
      console.warn('[codex-history-import] Could not remove staged copy:', staged, error)
      left.push(staged)
    }
  }
  await writeRecord(recordPath, left)
}
