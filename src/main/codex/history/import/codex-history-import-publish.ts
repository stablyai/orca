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

/** Whether `folder` takes hard links, which publishing a copy needs; checked before any copy. */
export async function canHardLinkIn(folder: string): Promise<boolean> {
  // Both names match the staged-copy sweep, so a crash here leaves nothing behind for good.
  const probe = join(folder, `.orca-import-probe-${randomUUID()}.tmp`)
  const probeLink = join(folder, `.orca-import-probe-${randomUUID()}.tmp`)
  await writeFile(probe, '', { flag: 'wx' })
  try {
    await link(probe, probeLink)
    return true
  } catch (error) {
    if (isHardLinkUnsupportedError(error)) {
      return false
    }
    throw error
  } finally {
    await rm(probeLink, { force: true })
    await rm(probe, { force: true })
  }
}

/**
 * `retry`: the source went, changed while copied, or is being deleted; its folder is read again.
 * `failed` and `no-hard-links` end the pass, so one broken store isn't copied into file after file.
 */
export type ImportPublishOutcome =
  | 'copied'
  | 'existing'
  | 'retry'
  | 'stopped'
  | 'failed'
  | 'no-hard-links'

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
    return error instanceof AtomicNoReplaceUnsupportedError ? 'no-hard-links' : 'failed'
  }
}
