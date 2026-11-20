import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createCodexRolloutFolderStamps } from './codex-rollout-folder-stamps'
import { createNestedWslLinkProbe, statUnlessAbsent } from './codex-rollout-path-probes'

const RELISTS_PER_SWEEP = 25

/** A real sessions or archived_sessions folder. */
export type CodexRolloutRoot = { path: string; archive: boolean }

export type CodexRolloutFolderRelists = {
  /** Stats what a full walk of this root lists: run the returned stamp once that walk succeeded. */
  beforeWalk(root: CodexRolloutRoot, dates: readonly string[][]): Promise<() => void>
  /**
   * The folders a new or newly archived rollout lands in, below roots already walked. Waits first
   * until a changed one would list settled, so one change is listed once: call it before reading
   * anything else, so nothing read earlier goes stale during the wait.
   */
  settle(roots: readonly CodexRolloutRoot[], dates: readonly string[][]): Promise<string[]>
  /**
   * Whether no folder settle names changed since its listing: a fork written into one already read,
   * while later files were still being read, would otherwise go unseen. Call it last.
   */
  unchanged(roots: readonly CodexRolloutRoot[], dates: readonly string[][]): Promise<boolean>
  /** Lists a folder again when it changed; false past the cap, which keeps the candidate. */
  relist(folder: string, list: (folder: string) => Promise<boolean>): Promise<boolean>
  report(): void
}

/**
 * Re-listing a folder is O(entries), and each deletion in it changes it: a sweep re-lists at most
 * RELISTS_PER_SWEEP changed folders, and later candidates wait for the next sweep.
 */
export function createCodexRolloutFolderRelists(signal?: AbortSignal): CodexRolloutFolderRelists {
  const stamps = createCodexRolloutFolderStamps()
  let left = RELISTS_PER_SWEEP
  let refused = 0

  /** Today's dated folders and the archive, skipping any below a link into WSL. */
  const foldersOf = async (roots: readonly CodexRolloutRoot[], dates: readonly string[][]) => {
    const linked = createNestedWslLinkProbe()
    const folders: string[] = []
    for (const root of roots) {
      for (const parts of root.archive ? [[]] : dates) {
        if (!(await linked(root.path, parts))) {
          folders.push(join(root.path, ...parts))
        }
      }
    }
    return folders
  }

  return {
    beforeWalk: async (root, dates) => {
      const stats = await Promise.all(
        (await foldersOf([root], dates)).map(async (folder) => ({
          folder,
          statAt: Date.now(),
          entry: await statUnlessAbsent(folder)
        }))
      )
      return () => {
        for (const { folder, statAt, entry } of stats) {
          if (entry) {
            stamps.listed(folder, entry.mtimeMs, statAt)
          }
        }
      }
    },
    settle: async (roots, dates) => {
      const folders = await foldersOf(roots, dates)
      let wait = 0
      for (const folder of left > 0 ? folders : []) {
        const entry = await statUnlessAbsent(folder)
        if (entry && stamps.state(folder, entry.mtimeMs) !== 'current') {
          wait = Math.max(wait, stamps.unsettledFor(entry.mtimeMs))
        }
      }
      await delay(wait, undefined, { signal })
      return folders
    },
    unchanged: async (roots, dates) => {
      for (const folder of await foldersOf(roots, dates)) {
        const entry = await statUnlessAbsent(folder)
        if (entry === undefined || (entry && stamps.state(folder, entry.mtimeMs) === 'changed')) {
          return false
        }
      }
      return true
    },
    relist: async (folder, list) => {
      const statAt = Date.now()
      const entry = await statUnlessAbsent(folder)
      if (!entry || stamps.state(folder, entry.mtimeMs) === 'current') {
        return entry !== undefined
      }
      if (left === 0) {
        refused += 1
        return false
      }
      left -= 1
      const listed = await list(folder)
      if (listed) {
        stamps.listed(folder, entry.mtimeMs, statAt)
      }
      return listed
    },
    report: () => {
      if (refused > 0) {
        console.info(
          `[workspace-cleanup] Kept ${refused} Codex rollouts for the next sweep: folder re-list cap reached`
        )
        refused = 0
      }
    }
  }
}
