// Which Claude ids name the same subagent, and which name no subagent at all.
//
// Claude re-announces a resumed task under a NEW `tool_use_id` while `task_id`
// stays put, so tool ids are aliases of a canonical task id — a store keyed on
// the tool id would show the child twice after every resume.
//
// The exclusions matter just as much: `task_updated` carries no `task_type` and
// child traffic carries no task metadata at all, so the one announcement that
// said "this is a backgrounded shell, not an agent" has to be remembered or a
// later frame re-admits it.

/** Both maps are event-accumulated and nothing prunes them, so both are bounded. */
const MAX_TOOL_USE_ALIASES = 512
const MAX_EXCLUDED_IDS = 512

export class ClaudeSubagentIds {
  private readonly canonicalByToolUse = new Map<string, string>()
  private readonly excluded = new Set<string>()

  /** The task id a tool id stands for, or the id itself when nothing aliases it. */
  canonical(id: string): string {
    return this.canonicalByToolUse.get(id) ?? id
  }

  alias(toolUseId: string, taskId: string): void {
    this.canonicalByToolUse.set(toolUseId, taskId)
    while (this.canonicalByToolUse.size > MAX_TOOL_USE_ALIASES) {
      const oldest = this.canonicalByToolUse.keys().next()
      if (oldest.done || oldest.value === toolUseId) {
        break
      }
      this.canonicalByToolUse.delete(oldest.value)
    }
  }

  exclude(id: string): void {
    this.excluded.add(id)
    while (this.excluded.size > MAX_EXCLUDED_IDS) {
      const oldest = this.excluded.values().next()
      if (oldest.done || oldest.value === id) {
        break
      }
      this.excluded.delete(oldest.value)
    }
  }

  isExcluded(...ids: (string | null)[]): boolean {
    return ids.some((id) => id !== null && this.excluded.has(id))
  }

  clear(): void {
    this.canonicalByToolUse.clear()
    this.excluded.clear()
  }
}
