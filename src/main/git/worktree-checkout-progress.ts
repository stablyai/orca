import type { WorktreeCheckoutProgress } from '../../shared/worktree/create-types'
import { createGitProgressRecordReader } from '../../shared/git-progress-records'

/** Receives checkout progress; `null` means git finished writing the files. */
export type WorktreeCheckoutProgressListener = (progress: WorktreeCheckoutProgress | null) => void

export type WorktreeCheckoutProgressReader = {
  read: (stderrChunk: string) => void
  /** Stops all reporting; call once the git process has settled. */
  close: () => void
}

/**
 * Turns the `Updating files` meter that `git worktree add` already writes to
 * stderr into progress reports. Reports synchronously with no timer, so nothing
 * can report after the process ends.
 */
export function createWorktreeCheckoutProgressReader(
  onProgress: WorktreeCheckoutProgressListener
): WorktreeCheckoutProgressReader {
  let lastPercent = -1
  let closed = false
  const read = createGitProgressRecordReader('Updating files', (record) => {
    if (closed) {
      return
    }
    if (record.done) {
      closed = true
      onProgress(null)
      return
    }
    // Why: git prints only on a percent change plus at most one same-percent
    // reprint after each one-second tick; increases only drops that reprint,
    // so reports stay ~100.
    if (record.percent <= lastPercent) {
      return
    }
    lastPercent = record.percent
    onProgress({ percent: record.percent, completed: record.completed, total: record.total })
  })
  return {
    read,
    close: () => {
      closed = true
    }
  }
}
