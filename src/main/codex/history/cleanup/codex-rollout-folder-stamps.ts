// Coarse filesystems stamp a folder no finer than this; a listing that close to a change repeats.
const FOLDER_STAMP_SLACK_MS = 2000

type Stamp = { mtimeMs: number; settled: boolean }

/** Current: the last listing still shows every entry. Unsettled: listed too close to this stamp. */
export type CodexRolloutFolderState = 'current' | 'unsettled' | 'changed'

export type CodexRolloutFolderStamps = {
  state(folder: string, mtimeMs: number): CodexRolloutFolderState
  /** How long until a listing of a folder with this stamp would be settled. */
  unsettledFor(mtimeMs: number): number
  /** `statAt`: when the stat taken before the listing ran. */
  listed(folder: string, mtimeMs: number, statAt: number): void
}

/** Each listed folder's stamp: a folder whose stamp hasn't moved since needs no listing again. */
export function createCodexRolloutFolderStamps(): CodexRolloutFolderStamps {
  const stamps = new Map<string, Stamp>()
  return {
    state: (folder, mtimeMs) => {
      const stamp = stamps.get(folder)
      return stamp?.mtimeMs !== mtimeMs ? 'changed' : stamp.settled ? 'current' : 'unsettled'
    },
    unsettledFor: (mtimeMs) =>
      Math.min(
        FOLDER_STAMP_SLACK_MS + 1,
        Math.max(0, mtimeMs + FOLDER_STAMP_SLACK_MS + 1 - Date.now())
      ),
    listed: (folder, mtimeMs, statAt) => {
      // A change later in the same clock tick as that stat would leave the stamp as it was.
      stamps.set(folder, { mtimeMs, settled: statAt - mtimeMs > FOLDER_STAMP_SLACK_MS })
    }
  }
}
