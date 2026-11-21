// A listing this close to a folder's stamp repeats: a later change in the same clock tick would
// leave the stamp as it was. Whole-second stamps come from a coarse filesystem (FAT stamps every
// 2 s); finer ones still tick with the system timer (Linux about 4 ms, Windows about 16 ms).
const COARSE_STAMP_SLACK_MS = 2000
const FINE_STAMP_SLACK_MS = 100

function slackFor(mtimeMs: number): number {
  return mtimeMs % 1000 === 0 ? COARSE_STAMP_SLACK_MS : FINE_STAMP_SLACK_MS
}

type Stamp = { mtimeMs: number; identity: string; settled: boolean }

/** What a stamp needs from a folder's stat: a folder replaced whole (a restore) is a new one. */
export type FolderStat = { mtimeMs: number; dev: number; ino: number }

const identityOf = (entry: FolderStat): string => `${entry.dev}:${entry.ino}`

/** Current: the last listing still shows every entry. Unsettled: listed too close to this stamp. */
export type CodexRolloutFolderState = 'current' | 'unsettled' | 'changed'

export type CodexRolloutFolderStamps = {
  state(folder: string, entry: FolderStat): CodexRolloutFolderState
  /** How long until a listing of a folder with this stamp would be settled. */
  unsettledFor(mtimeMs: number): number
  /** `statAt`: when the stat taken before the listing ran. */
  listed(folder: string, entry: FolderStat, statAt: number): void
}

/** Each listed folder's stamp: a folder whose stamp hasn't moved since needs no listing again. */
export function createCodexRolloutFolderStamps(): CodexRolloutFolderStamps {
  const stamps = new Map<string, Stamp>()
  return {
    state: (folder, entry) => {
      const stamp = stamps.get(folder)
      if (stamp?.mtimeMs !== entry.mtimeMs || stamp.identity !== identityOf(entry)) {
        return 'changed'
      }
      return stamp.settled ? 'current' : 'unsettled'
    },
    unsettledFor: (mtimeMs) => {
      const slack = slackFor(mtimeMs)
      return Math.min(slack + 1, Math.max(0, mtimeMs + slack + 1 - Date.now()))
    },
    listed: (folder, entry, statAt) => {
      const { mtimeMs } = entry
      stamps.set(folder, {
        mtimeMs,
        identity: identityOf(entry),
        settled: statAt - mtimeMs > slackFor(mtimeMs)
      })
    }
  }
}
