import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { removeStagedCopy } from '../rollouts/codex-rollout-staged-copy'

export async function readEntries(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

// `.orca-import-<runId>-…tmp`: staged by an import, removed by its publish or by a later sweep.
const IMPORT_STAGED_COPY = /^\.orca-import-([^-]+)-.+\.tmp$/
// Another instance's import may still be staging; one untouched for a day has been abandoned.
const ABANDONED_AFTER_MS = 24 * 60 * 60_000

async function sweepAbandonedCopy(path: string): Promise<void> {
  try {
    // utimes gives a staged copy its source's mtime, so its age is the ctime.
    if (Date.now() - (await stat(path)).ctimeMs > ABANDONED_AFTER_MS) {
      await removeStagedCopy(path)
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      console.warn('[codex-history-import] Could not remove staged copy:', path, error)
    }
  }
}

/** The store's rollout names per folder, each folder listed once per pass. */
export class StoreNames {
  private readonly folders = new Map<string, Promise<Set<string>>>()

  constructor(
    private readonly storeHome: string,
    private readonly runId: string
  ) {}

  names(folder: string): Promise<Set<string>> {
    let names = this.folders.get(folder)
    if (!names) {
      names = readEntries(join(this.storeHome, folder)).then(async (entries) => {
        const kept = new Set<string>()
        for (const { name } of entries) {
          const staged = IMPORT_STAGED_COPY.exec(name)
          if (staged) {
            if (staged[1] !== this.runId) {
              await sweepAbandonedCopy(join(this.storeHome, folder, name))
            }
          } else {
            kept.add(name)
          }
        }
        return kept
      })
      this.folders.set(folder, names)
    }
    return names
  }

  /** Whether `folder` holds the rollout in either form. */
  async holds(folder: string | null, name: string): Promise<boolean> {
    if (folder === null) {
      return false
    }
    const names = await this.names(folder)
    return names.has(name) || names.has(rolloutTwinPath(name))
  }
}
