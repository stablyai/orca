// Why: OMP creates SQLite auth/history DBs lazily under PI_CODING_AGENT_DIR.
// If Orca only mirrors files that already exist, /login writes land in a
// disposable overlay instead of the user's ~/.omp/agent store.

import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorWritableFileEntry, safeRemoveTree } from './overlay-mirror'

export const OMP_PERSISTENT_SQLITE_FILES = ['agent.db'] as const

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

function ensureEmptyFile(path: string): void {
  closeSync(openSync(path, 'a'))
}

function mirrorOmpSqliteFile(
  sourcePath: string,
  overlayPath: string,
  databaseName: string
): string[] {
  if (!existsSync(sourcePath)) {
    ensureEmptyFile(sourcePath)
  }

  safeRemoveTree(overlayPath)
  for (const sidecarSuffix of SQLITE_SIDECAR_SUFFIXES) {
    safeRemoveTree(`${overlayPath}${sidecarSuffix}`)
  }

  mirrorWritableFileEntry(sourcePath, overlayPath)
  const mirroredEntries = [databaseName]

  if (process.platform === 'win32') {
    // Why: Windows hardlinks do not redirect SQLite's derived WAL filenames.
    // Link sidecars too so lazy WAL writes still land in ~/.omp/agent.
    for (const sidecarSuffix of SQLITE_SIDECAR_SUFFIXES) {
      const sourceSidecar = `${sourcePath}${sidecarSuffix}`
      const sidecarName = `${mirroredEntries[0]}${sidecarSuffix}`
      ensureEmptyFile(sourceSidecar)
      mirrorWritableFileEntry(sourceSidecar, `${overlayPath}${sidecarSuffix}`)
      mirroredEntries.push(sidecarName)
    }
  }

  return mirroredEntries
}

export function mirrorOmpPersistentSqliteFiles(
  sourceAgentDir: string,
  overlayDir: string
): string[] {
  mkdirSync(sourceAgentDir, { recursive: true })
  return OMP_PERSISTENT_SQLITE_FILES.flatMap((databaseName) =>
    mirrorOmpSqliteFile(
      join(sourceAgentDir, databaseName),
      join(overlayDir, databaseName),
      databaseName
    )
  )
}
