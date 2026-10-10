/** The title came from a restore snapshot, and no title has been observed live since.
 *  Why: only live observations stamp lastOscTitleEpochMs; a restored title can outlive its agent.
 *  Why replaced titles too: a pane keeps echoing one after its incarnation is gone. */
export function ptyTitleIsRestored(
  pty: {
    lastOscTitle: string | null
    lastOscTitleEpochMs: number | null
    replacedRestoredTitles?: string[]
  },
  title: string | null
): boolean {
  return (
    title !== null &&
    pty.lastOscTitleEpochMs === null &&
    (title === pty.lastOscTitle?.trim() || pty.replacedRestoredTitles?.includes(title) === true)
  )
}
