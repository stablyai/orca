import type { TrackedClaudeBackgroundTask } from './claude-settled-background-tasks'

/** Keep live foreground work beside the provider's authoritative background roster. */
export function combineClaudeBackgroundTaskRoster(
  prior: ReadonlyMap<string, TrackedClaudeBackgroundTask>,
  roster: ReadonlyMap<string, TrackedClaudeBackgroundTask>
): Map<string, TrackedClaudeBackgroundTask> {
  const combined = new Map<string, TrackedClaudeBackgroundTask>()
  for (const [id, task] of prior) {
    if (!task.backgrounded && task.liveInTurn && !roster.has(id)) {
      combined.set(id, task)
    }
  }
  for (const [id, task] of roster) {
    combined.set(id, task)
  }
  return combined
}
