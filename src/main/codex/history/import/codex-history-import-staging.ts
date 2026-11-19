import { randomUUID } from 'node:crypto'
import { link, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { COMPRESSED_ROLLOUT_SUFFIX, plainWins } from '../rollouts/codex-rollout-compressed-twin'
import {
  AtomicNoReplaceUnsupportedError,
  copyCodexRolloutWithoutOverwrite,
  isHardLinkUnsupportedError
} from '../rollouts/codex-rollout-copy'
import { RolloutSourceReadError } from '../rollouts/codex-rollout-staged-copy'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'

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

// Store folders a probe found without hard links; tried again once the setting changes or Orca restarts.
const foldersWithoutHardLinks = new Set<string>()

export function forgetStoreFoldersWithoutHardLinks(): void {
  foldersWithoutHardLinks.clear()
}

/** Whether `folder` takes hard links, which publishing a copy needs; checked before any copy. */
export async function canHardLinkIn(folder: string): Promise<boolean> {
  if (foldersWithoutHardLinks.has(folder)) {
    return false
  }
  // Both names match the staged-copy sweep, so a crash here leaves nothing behind for good.
  const probe = join(folder, `.orca-import-probe-${randomUUID()}.tmp`)
  const probeLink = join(folder, `.orca-import-probe-${randomUUID()}.tmp`)
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

/**
 * `retry`: this file alone failed (its source unreadable, gone, changed while copied or being
 * deleted); its folder is read again next pass. `failed`: the store refused a write, which ends
 * the pass so a broken store isn't copied into file after file.
 */
export type ImportPublishOutcome = 'copied' | 'existing' | 'retry' | 'stopped' | 'failed'

export async function copyIntoStore(
  from: string,
  to: string,
  shouldStop: () => boolean
): Promise<ImportPublishOutcome> {
  try {
    // Held from the first byte copied to the link, so a deletion can't race the new name.
    const outcome = await linkCodexRolloutUnlessHeld(from, () =>
      copyCodexRolloutWithoutOverwrite(from, to, {
        purpose: 'import',
        requireStableSource: true,
        shouldStop
      })
    )
    return outcome === 'held' || outcome === 'source-changed' ? 'retry' : outcome
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'retry'
    }
    console.warn(`[codex-history-import] Could not copy ${from}:`, error)
    // The probe found hard links here, so a refused link is this file's alone.
    return error instanceof RolloutSourceReadError ||
      error instanceof AtomicNoReplaceUnsupportedError
      ? 'retry'
      : 'failed'
  }
}
