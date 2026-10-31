// Resumes change tool IDs but keep task IDs; retain aliases across restarts and remember non-agent exclusions.

import { isBoundedClaudeTaskId } from './claude-background-task-tracker'

/** Bound event-accumulated aliases and exclusions. */
const MAX_TOOL_USE_ALIASES = 512
const MAX_EXCLUDED_IDS = 512

export class ClaudeSubagentIds {
  private readonly canonicalByToolUse = new Map<string, string>()
  private readonly excluded = new Set<string>()

  constructor(private readonly journaled?: (toolUseId: string) => string | null) {}

  canonical(id: string): string {
    return this.canonicalByToolUse.get(id) ?? this.journaled?.(id) ?? id
  }

  /** Announcement evidence distinguishes a settled self-alias from an unknown ID. */
  isAnnounced(toolUseId: string): boolean {
    return this.canonicalByToolUse.has(toolUseId) || (this.journaled?.(toolUseId) ?? null) !== null
  }

  alias(toolUseId: string, taskId: string): void {
    if (!isBoundedClaudeTaskId(toolUseId) || !isBoundedClaudeTaskId(taskId)) {
      return
    }
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
    if (!isBoundedClaudeTaskId(id)) {
      return
    }
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
