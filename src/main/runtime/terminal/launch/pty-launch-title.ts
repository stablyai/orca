import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

/** Spawn completion must not give a launch label newer authority than titles received in flight. */
export function seedPtyLaunchTitle(
  pty: RuntimePtyWorktreeRecord,
  title: string | null | undefined,
  observedAt: { sequence: number; epochMs: number },
  setManagementTitle: (title: string, observedAt: number) => void
): void {
  if (Math.max(pty.titleUpdatedAt ?? 0, pty.lastOscTitleAt ?? 0) > observedAt.sequence) {
    return
  }
  pty.title = title || null
  pty.titleUpdatedAt = title ? observedAt.sequence : null
  pty.titleObservedAtEpochMs = title ? observedAt.epochMs : null
  if (title) {
    setManagementTitle(title, observedAt.sequence)
  }
}
