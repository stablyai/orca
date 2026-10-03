import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/** Records a `terminal rename` on the PTY that list summaries read the title from. */
export function stampRenamedPtyTitle(
  pty: Pick<RuntimePtyWorktreeRecord, 'title' | 'titleUpdatedAt'> | undefined,
  title: string | null
): void {
  if (!pty) {
    return
  }
  pty.title = title
  // Why: a manual rename must outrank later agent OSC title updates (which
  // win by timestamp), so stamp it as the freshest title.
  pty.titleUpdatedAt = Date.now()
}
