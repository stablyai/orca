import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export type ProfileStateStorageClassification = 'json-only' | 'sqlite-only' | 'both' | 'neither'

/** Primary first: recovery must remove it before any journal can be replayed. */
export function profileStateDatabaseFiles(databaseFile: string): string[] {
  return ['', '-wal', '-shm', '-journal'].map((suffix) => `${databaseFile}${suffix}`)
}

/** Any surviving database-family file rules out a fresh profile or JSON fallback. */
export function hasProfileStateDatabaseFiles(databaseFile: string): boolean {
  return profileStateDatabaseFiles(databaseFile).some(existsSync)
}

export function classifyProfileStateStorage(
  dataFile: string,
  databaseFile: string
): ProfileStateStorageClassification {
  const hasJson = existsSync(dataFile)
  const hasDatabase = hasProfileStateDatabaseFiles(databaseFile)
  if (hasJson && hasDatabase) {
    return 'both'
  }
  if (hasJson) {
    return 'json-only'
  }
  if (hasDatabase) {
    return 'sqlite-only'
  }
  return 'neither'
}

export async function hasProfileStateDatabaseFilesAsync(databaseFile: string): Promise<boolean> {
  const present = await Promise.all(
    profileStateDatabaseFiles(databaseFile).map(async (path) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    })
  )
  return present.some(Boolean)
}
