import { rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { AtomicNoReplaceUnsupportedError, linkStagedRollout } from '../rollouts/codex-rollout-copy'
import {
  codexRolloutDeletionEpoch,
  linkCodexRolloutUnlessHeld
} from '../rollouts/codex-rollout-deletion-guard'
import { removeStagedCopy } from '../rollouts/codex-rollout-staged-copy'

export type StagedImport = {
  staged: string
  /** Where the rollout joins the store. */
  final: string
  /** Store folders that would hold another form of it: the same folder, and the other place. */
  storeFolders: string[]
  indexPendingDir: string
  /** The deletion epoch when staging began. */
  deletionEpoch: number
  /** The import setting is unchanged and Orca isn't quitting. */
  isCurrent: () => boolean
  isHandled: () => boolean
  /** Called as soon as the rollout is in the store, before anything else can fail or wait. */
  recordPublished: () => Promise<void>
}

/**
 * `refused`: published nothing, and the conversation stays unhandled for a later pass.
 * `store-holds`: the store already has a form of it. `failed`: the store refused a write, or the staging record is full.
 */
export type ImportPublishOutcome = 'copied' | 'existing' | 'store-holds' | 'refused' | 'failed'

async function storeHoldsAnyForm(folders: string[], name: string): Promise<boolean> {
  const forms = folders.flatMap((folder) => [
    join(folder, name),
    join(folder, rolloutTwinPath(name))
  ])
  return (await Promise.all(forms.map(lstatIfPresent))).some(Boolean)
}

async function linkUnlessDeleted(job: StagedImport): Promise<'copied' | 'existing' | 'refused'> {
  // A deletion that came and went since staging began must not see its conversation return (one
  // of any other rollout only delays this one to a later pass), and a changed setting publishes nothing.
  const stillWanted = (): boolean =>
    codexRolloutDeletionEpoch() === job.deletionEpoch && job.isCurrent()
  const outcome = await linkCodexRolloutUnlessHeld(job.final, async () => {
    if (!stillWanted()) {
      return 'refused'
    }
    // Recorded before the link, so the store's index learns every rollout that joins it.
    const marker = join(job.indexPendingDir, basename(job.final))
    await writeFile(marker, '')
    let linked: 'copied' | 'existing'
    try {
      // Checked again with nothing awaited before the link, which is the publish.
      if (!stillWanted()) {
        await rm(marker, { force: true, maxRetries: 3 })
        return 'refused'
      }
      linked = await linkStagedRollout(job.staged, job.final)
    } catch (error) {
      // No heal runs during a publish, so the marker can't settle the thread as missing.
      await rm(marker, { force: true, maxRetries: 3 })
      throw error
    }
    await job.recordPublished()
    return linked
  })
  return outcome === 'held' ? 'refused' : outcome
}

/**
 * Publishes one staged copy, inside the history queue: it touches only `~/.codex`, never the
 * import folder, so it takes no longer than a few metadata operations. Removes the staged copy.
 */
export async function publishStagedImport(job: StagedImport): Promise<ImportPublishOutcome> {
  try {
    if (!job.isCurrent() || job.isHandled()) {
      return 'refused'
    }
    // Listed afresh: history passes may have moved a form in since staging.
    if (await storeHoldsAnyForm(job.storeFolders, basename(job.final))) {
      return 'store-holds'
    }
    return await linkUnlessDeleted(job)
  } catch (error) {
    console.warn(`[codex-history-import] Could not publish ${job.final}:`, error)
    // The probe found hard links in this folder, so a refused link is this file's alone; a staged
    // copy another instance swept away is retried.
    return error instanceof AtomicNoReplaceUnsupportedError || isDefinitiveAbsence(error)
      ? 'refused'
      : 'failed'
  } finally {
    await removeStagedCopy(job.staged).catch((error: unknown) =>
      console.warn('[codex-history-import] Could not remove staged copy:', job.staged, error)
    )
  }
}
