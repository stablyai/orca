import { lstat, rm } from 'node:fs/promises'

/** Deletes a config Orca's removal left with nothing user-owned; false keeps a symlink or a missing file. */
export async function removeConfigLeftEmpty(configPath: string): Promise<boolean> {
  const link = await lstat(configPath).catch(() => null)
  if (!link || link.isSymbolicLink()) {
    return false
  }
  await rm(configPath, { force: true })
  return true
}
