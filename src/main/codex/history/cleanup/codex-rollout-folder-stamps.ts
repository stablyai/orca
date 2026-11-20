import { realpath, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

// Coarse filesystems stamp a folder no finer than this; a listing that close to a change repeats.
const FOLDER_STAMP_SLACK_MS = 2000

type Stamp = { mtimeMs: number; settled: boolean }

export type CodexRolloutFolderStamps = {
  /** Whether the last listing of this folder still shows every entry. */
  isCurrent(folder: string, mtimeMs: number): boolean
  /** `statAt`: when the stat taken before the listing ran. */
  listed(folder: string, mtimeMs: number, statAt: number): void
  /** Unlinks a name without its own change making a listed folder read as changed. */
  unlink(path: string): Promise<void>
}

/** Each listed folder's stamp: a folder whose stamp hasn't moved since needs no listing again. */
export function createCodexRolloutFolderStamps(): CodexRolloutFolderStamps {
  const stamps = new Map<string, Stamp>()
  return {
    isCurrent: (folder, mtimeMs) => {
      const stamp = stamps.get(folder)
      return stamp?.settled === true && stamp.mtimeMs === mtimeMs
    },
    listed: (folder, mtimeMs, statAt) => {
      // A change later in the same clock tick as that stat would leave the stamp as it was.
      stamps.set(folder, { mtimeMs, settled: statAt - mtimeMs > FOLDER_STAMP_SLACK_MS })
    },
    unlink: async (path) => {
      const folder = await realpath(dirname(path)).catch(() => null)
      const stamp = folder === null ? undefined : stamps.get(folder)
      const before = stamp?.settled && folder ? await stat(folder).catch(() => null) : null
      await unlink(path)
      if (!folder || !before || before.mtimeMs !== stamp?.mtimeMs) {
        return
      }
      const after = await stat(folder).catch(() => null)
      // Sub-second clocks only: within a whole-second tick another entry could hide behind ours.
      if (after && after.mtimeMs % 1000 !== 0) {
        stamps.set(folder, { mtimeMs: after.mtimeMs, settled: true })
      }
    }
  }
}
