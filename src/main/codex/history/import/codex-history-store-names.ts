import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
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

// Staged by an import that stopped before cleaning up; passes are serialized, so none is live.
const IMPORT_STAGED_COPY = /^\.orca-import-.+\.tmp$/

async function sweepStagedCopy(path: string): Promise<void> {
  try {
    await removeStagedCopy(path)
  } catch (error) {
    console.warn('[codex-history-import] Could not remove staged copy:', path, error)
  }
}

/** The store's rollout names per folder, each folder listed once per pass. */
export class StoreNames {
  private readonly folders = new Map<string, Promise<Set<string>>>()

  constructor(private readonly storeHome: string) {}

  names(folder: string): Promise<Set<string>> {
    let names = this.folders.get(folder)
    if (!names) {
      names = readEntries(join(this.storeHome, folder)).then(async (entries) => {
        const kept = new Set<string>()
        for (const { name } of entries) {
          if (IMPORT_STAGED_COPY.test(name)) {
            await sweepStagedCopy(join(this.storeHome, folder, name))
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
