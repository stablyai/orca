import { setTimeout as delay } from 'node:timers/promises'
import type { CodexRolloutFolderStamps } from './codex-rollout-folder-stamps'

const ARCHIVE_RELISTS_PER_SWEEP = 25

export type CodexRolloutArchiveRelists = {
  /**
   * Whether a changed archive may be re-listed now; waits until a listing would be settled, so the
   * same change is listed once. False past the cap: the candidate is kept for the next sweep.
   */
  admit(folder: string, mtimeMs: number): Promise<boolean>
  report(): void
}

/** Each deletion of an archived name changes its folder, and re-listing it is O(entries). */
export function createCodexRolloutArchiveRelists(
  stamps: CodexRolloutFolderStamps,
  signal?: AbortSignal
): CodexRolloutArchiveRelists {
  let left = ARCHIVE_RELISTS_PER_SWEEP
  let refused = 0
  return {
    admit: async (folder, mtimeMs) => {
      const changed = stamps.state(folder, mtimeMs) === 'changed'
      if (changed && left === 0) {
        refused += 1
        return false
      }
      left -= changed ? 1 : 0
      await delay(stamps.unsettledFor(mtimeMs), undefined, { signal })
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
