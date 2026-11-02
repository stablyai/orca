import type { TrackedClaudeBackgroundTask } from './claude-settled-background-tasks'

/** Keep live foreground work beside the provider's authoritative background roster. */
export function combineClaudeBackgroundTaskRoster(
  prior: ReadonlyMap<string, TrackedClaudeBackgroundTask>,
  roster: ReadonlyMap<string, TrackedClaudeBackgroundTask>,
  limit: number
): Map<string, TrackedClaudeBackgroundTask> {
  const combined = new Map<string, TrackedClaudeBackgroundTask>()
  const retainable = [...prior].filter(
    ([id, task]) => !task.backgrounded && task.liveInTurn && !roster.has(id)
  )
  let evict = Math.max(0, roster.size + retainable.length - limit)
  // Drop oldest foreground rows first; preserve the provider's roster order.
  for (const [id, task] of retainable) {
    if (evict > 0) {
      evict -= 1
      continue
    }
    combined.set(id, task)
  }
  for (const [id, task] of roster) {
    combined.set(id, task)
  }
  return combined
}
