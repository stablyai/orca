import { randomUUID } from 'node:crypto'
import { gitExecFileAsync } from '../command-runner/git-exec-file'

type GitExecOptions = Parameters<typeof gitExecFileAsync>[1]

/** A per-run GIT_REFLOG_ACTION, so the HEAD reflog says which rebase run moved HEAD. */
export function newOrcaRebaseReflogAction(): string {
  return `rebase (orca ${randomUUID().slice(0, 8)})`
}

/**
 * True only when HEAD sits where this run left it and every HEAD move since this run's start was
 * this run's own. A run started or continued by anything else writes its own entries after ours.
 */
export async function headMovedOnlyByRebaseRun(
  reflogAction: string,
  options: GitExecOptions
): Promise<boolean> {
  try {
    const head = (await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], options)).stdout.trim()
    const { stdout } = await gitExecFileAsync(
      ['reflog', 'show', '-n', '1000', '--format=%H%x00%gs', 'HEAD', '--'],
      options
    )
    const entries = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\0'))
    if (entries[0]?.[0] !== head) {
      return false
    }
    for (const [, subject = ''] of entries) {
      if (!subject.startsWith(`${reflogAction} (`)) {
        return false
      }
      if (subject.startsWith(`${reflogAction} (start)`)) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}
