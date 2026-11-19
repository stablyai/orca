import type { BigIntStats } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'

/** A folder's entries; none when it doesn't exist. */
export async function readEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

/** Regular files under `folder`, at any depth; stops descending once `shouldStop` says so. */
export async function* regularFiles(
  folder: string,
  shouldStop: () => boolean = () => false
): AsyncGenerator<{ path: string; stats: BigIntStats }> {
  if (shouldStop()) {
    return
  }
  for (const entry of await readEntries(folder)) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      yield* regularFiles(path, shouldStop)
    } else if (entry.isFile()) {
      const stats = await lstatIfPresent(path)
      if (stats?.isFile()) {
        yield { path, stats }
      }
    }
  }
}
