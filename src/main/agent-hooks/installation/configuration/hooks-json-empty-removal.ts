import { lstatSync, rmSync } from 'node:fs'

/** Deletes a config Orca's removal left with nothing user-owned; false keeps a symlink or a missing file. */
export function removeConfigLeftEmpty(configPath: string): boolean {
  try {
    if (lstatSync(configPath).isSymbolicLink()) {
      return false
    }
  } catch {
    return false
  }
  rmSync(configPath, { force: true })
  return true
}
