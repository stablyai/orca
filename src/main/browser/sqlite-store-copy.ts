import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export type ChromiumStoreCopy = {
  /** The temporary directory that was created. */
  tempDir: string
  /** The path to the copied DB file inside tempDir. */
  tempDbPath: string
  /** Removes the entire tempDir. Always call this when done (error or success). */
  cleanup: () => void
}

/**
 * Copies a locked Chromium SQLite store (and its `-wal`/`-shm` sidecars, if
 * present) into a fresh temporary directory.
 *
 * Why: the browser process holds a read lock on its live DB. Copying to a temp
 * location avoids lock contention and gives us a consistent, point-in-time
 * snapshot. The `-wal` sidecar may contain cookies not yet flushed to the main
 * file, so we copy it too (best-effort — the main DB alone is still useful if
 * the sidecar copy fails).
 */
export function copyChromiumStoreToTemp(dbPath: string): ChromiumStoreCopy {
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
  const tempDbPath = join(tempDir, basename(dbPath))

  const cleanup = (): void => {
    rmSync(tempDir, { recursive: true, force: true })
  }

  copyFileSync(dbPath, tempDbPath)

  // Why: when the source browser is running, it uses WAL journal mode. The most
  // recently written data (including fresh auth tokens) may only exist in the WAL
  // sidecar, not yet flushed to the main DB. Copying WAL + SHM ensures our
  // snapshot reflects the browser's current state.
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = dbPath + suffix
    if (existsSync(sidecar)) {
      try {
        copyFileSync(sidecar, tempDbPath + suffix)
      } catch {
        // Why: sidecar copy is best-effort. The main DB alone may still have
        // enough data for a usable session; missing the WAL just means we might
        // miss the very latest writes.
      }
    }
  }

  return { tempDir, tempDbPath, cleanup }
}
