// Which Claude tool calls this session actually forwarded to the top-level
// transcript.
//
// A task announces the tool call that spawned it. That tool call is only
// evidence the user can act on when it was forwarded at the TOP level: a nested
// Task spawned from inside a subagent's sidechain names a tool id that exists
// only in that sidechain, and a row minted for it would claim a top-level
// invocation that never appeared. So admission asks this registry, and a task
// whose parent was never forwarded yields no row at all.

/** Event-accumulated and pruned by nothing, so bounded. Eviction is oldest
 *  first: a tool id old enough to fall out can no longer be the parent of a
 *  task announcement still in flight. */
const MAX_FORWARDED_TOOL_IDS = 512

export class ClaudeForwardedToolRegistry {
  private readonly ids = new Set<string>()

  /** Record a tool call forwarded at the top level. Nested traffic must not
   *  reach here — its caller checks `parent_tool_use_id` first. */
  record(toolUseId: string): void {
    if (toolUseId.length === 0) {
      return
    }
    this.ids.delete(toolUseId)
    this.ids.add(toolUseId)
    while (this.ids.size > MAX_FORWARDED_TOOL_IDS) {
      const oldest = this.ids.values().next()
      if (oldest.done || oldest.value === toolUseId) {
        break
      }
      this.ids.delete(oldest.value)
    }
  }

  has(toolUseId: string): boolean {
    return this.ids.has(toolUseId)
  }

  clear(): void {
    this.ids.clear()
  }
}
