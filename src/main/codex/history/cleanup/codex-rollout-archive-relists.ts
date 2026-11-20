import { setTimeout as delay } from 'node:timers/promises'
import type { CodexRolloutFolderStamps } from './codex-rollout-folder-stamps'
import { statUnlessAbsent } from './codex-rollout-path-probes'

const ARCHIVE_RELISTS_PER_SWEEP = 25

export type CodexRolloutArchiveRelists = {
  /** An archive folder this sweep read in full; later refreshes re-list it when it changed. */
  track(folder: string): void
  /**
   * Before a refresh reads any folder: waits until a changed archive would list settled, so one
   * change is listed once, and so no folder read before the wait goes stale during it.
   */
  settle(): Promise<void>
  /** Charges one re-list; false past the cap, and the candidate is kept for the next sweep. */
  admit(): boolean
  report(): void
}

/** Each deletion of an archived name changes its folder, and re-listing it is O(entries). */
export function createCodexRolloutArchiveRelists(
  stamps: CodexRolloutFolderStamps,
  signal?: AbortSignal
): CodexRolloutArchiveRelists {
  const folders = new Set<string>()
  let left = ARCHIVE_RELISTS_PER_SWEEP
  let refused = 0
  return {
    track: (folder) => {
      folders.add(folder)
    },
    settle: async () => {
      let wait = 0
      for (const folder of left > 0 ? folders : []) {
        const entry = await statUnlessAbsent(folder)
        if (entry && stamps.state(folder, entry.mtimeMs) !== 'current') {
          wait = Math.max(wait, stamps.unsettledFor(entry.mtimeMs))
        }
      }
      await delay(wait, undefined, { signal })
    },
    admit: () => {
      if (left === 0) {
        refused += 1
        return false
      }
      left -= 1
      return true
    },
    report: () => {
      if (refused > 0) {
        console.info(
          `[workspace-cleanup] Kept ${refused} Codex rollouts for the next sweep: archive re-list cap reached`
        )
        refused = 0
      }
    }
  }
}
