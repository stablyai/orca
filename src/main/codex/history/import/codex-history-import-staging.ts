import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, link, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { COMPRESSED_ROLLOUT_SUFFIX, plainWins } from '../rollouts/codex-rollout-compressed-twin'
import { isHardLinkUnsupportedError } from '../rollouts/codex-rollout-copy'
import {
  clearDarwinFileFlags,
  readingSource,
  removeStagedCopy,
  stageRolloutCopy
} from '../rollouts/codex-rollout-staged-copy'

/**
 * The form of one conversation to copy when the import folder has both: a newer plain form,
 * otherwise the non-empty compressed one. Null when every form has gone since the listing.
 */
export async function pickImportForm(
  folder: string,
  key: string,
  forms: readonly string[]
): Promise<string | null> {
  if (forms.length === 1) {
    return forms[0]
  }
  const compressedName = `${key}${COMPRESSED_ROLLOUT_SUFFIX}`
  const [plain, compressed] = await Promise.all([
    lstatIfPresent(join(folder, key)),
    lstatIfPresent(join(folder, compressedName))
  ])
  if (!plain?.isFile()) {
    return compressed?.isFile() ? compressedName : null
  }
  return !compressed?.isFile() || plainWins(plain, compressed) ? key : compressedName
}

/** `.orca-import-<runId>-<uuid>.tmp`: never a rollout name, and swept once its run is long gone. */
export function stagedImportPath(folder: string, runId: string): string {
  return join(folder, `.orca-import-${runId}-${randomUUID()}.tmp`)
}

// Store folders a probe found without hard links; tried again once the setting changes or Orca restarts.
const foldersWithoutHardLinks = new Set<string>()

export function forgetStoreFoldersWithoutHardLinks(): void {
  foldersWithoutHardLinks.clear()
}

/** Whether `folder` takes hard links, which publishing a copy needs; checked before any copy. */
export async function canHardLinkIn(folder: string, runId: string): Promise<boolean> {
  if (foldersWithoutHardLinks.has(folder)) {
    return false
  }
  // Both are staged-copy names, so a later run's sweep removes any a crash leaves here.
  const probe = stagedImportPath(folder, runId)
  const probeLink = stagedImportPath(folder, runId)
  await writeFile(probe, '', { flag: 'wx' })
  try {
    await link(probe, probeLink)
    return true
  } catch (error) {
    if (!isHardLinkUnsupportedError(error)) {
      throw error
    }
    foldersWithoutHardLinks.add(folder)
    console.warn(`[codex-history-import] Not importing into ${folder}: it has no hard links`)
    return false
  } finally {
    await rm(probeLink, { force: true })
    await rm(probe, { force: true })
  }
}

const OWNER_READ_WRITE = 0o600n

/**
 * Codex appends to the conversation it resumes, but a copy keeps a read-only source's mode: the
 * copy gets owner read/write. A macOS Finder lock the clone kept refuses the chmod until cleared
 * (the link clears it anyway).
 */
async function makeStagedCopyWritable(staged: string, mode: bigint): Promise<void> {
  if ((mode & OWNER_READ_WRITE) === OWNER_READ_WRITE) {
    return
  }
  const writableMode = Number((mode & 0o777n) | OWNER_READ_WRITE)
  try {
    await chmod(staged, writableMode)
  } catch (error) {
    if (process.platform !== 'darwin' || !(await clearDarwinFileFlags(staged))) {
      throw error
    }
    await chmod(staged, writableMode)
  }
}

function sameSource(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    // The copy took whatever mode the source had when copied; a changed one may have skipped the chmod.
    before.mode === after.mode
  )
}

/** Whether `folder` takes a new file: a copy that failed while it does failed on its source. */
export async function canWriteIn(folder: string, runId: string): Promise<boolean> {
  const probe = stagedImportPath(folder, runId)
  try {
    await writeFile(probe, '', { flag: 'wx' })
    await rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Copies `from` to the staged path `staged`, outside the history queue so a slow or frozen import
 * folder holds up only the import. `source-changed`: Codex wrote to it meanwhile, so the copy is
 * dropped (as on any failure).
 */
export async function stageImportRollout(
  from: string,
  staged: string
): Promise<'staged' | 'source-changed'> {
  const readSource = (): Promise<BigIntStats> =>
    readingSource(from, () => stat(from, { bigint: true }))
  const source = await readSource()
  let kept = false
  try {
    await stageRolloutCopy(source, from, staged)
    await makeStagedCopyWritable(staged, source.mode)
    if (!sameSource(source, await readSource())) {
      return 'source-changed'
    }
    kept = true
    return 'staged'
  } finally {
    if (!kept) {
      await removeStagedCopy(staged).catch((error: unknown) =>
        console.warn('[codex-history-import] Could not remove staged copy:', staged, error)
      )
    }
  }
}
