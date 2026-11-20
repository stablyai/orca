// Coarse filesystems stamp a folder no finer than this; a listing that close to a change repeats.
const FOLDER_STAMP_SLACK_MS = 2000

type Stamp = { mtimeMs: number; settled: boolean }

export type CodexRolloutFolderStamps = {
  /** Whether the last listing of this folder still shows every entry. */
  isCurrent(folder: string, mtimeMs: number): boolean
  /** `statAt`: when the stat taken before the listing ran. */
  listed(folder: string, mtimeMs: number, statAt: number): void
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
    }
  }
}
