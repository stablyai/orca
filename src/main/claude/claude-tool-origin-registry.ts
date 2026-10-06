// Where each Claude tool call this session journaled came from.
//
// Two questions, one registry, because both are answered by the same fact —
// which agent's row carried a tool call:
//
// A task announces the tool call that spawned it. That tool call is only
// evidence the user can act on when it was forwarded at the TOP level: a nested
// Task spawned from inside a subagent's sidechain names a tool id that exists
// only in that sidechain, and a row minted for it would claim a top-level
// invocation that never appeared. So admission asks this registry, and a task
// whose parent was never forwarded yields no row at all.
//
// The same sidechain tool id is also the only handle a GRANDCHILD's frames
// carry. Recording which child journaled it is what lets a grandchild row name
// its real parent instead of leaving the field absent, which under this
// journal's semantics would claim the session's own agent spawned it.

/** Both stores are event-accumulated and pruned by nothing, so both are
 *  bounded. Eviction is oldest first: a tool id old enough to fall out can no
 *  longer be the parent of a task announcement still in flight. They are kept
 *  separate so that heavy sidechain traffic cannot evict the top-level spawn
 *  ids an announcement is still expected for. */
const MAX_TOP_LEVEL_TOOL_IDS = 512
const MAX_CHILD_TOOL_ORIGINS = 512

export class ClaudeToolOriginRegistry {
  private readonly topLevel = new Set<string>()
  private readonly childOwnerRefs = new Map<string, string>()

  /** Record a tool call journaled at the top level, by the session's own agent. */
  recordTopLevel(toolUseId: string): void {
    if (toolUseId.length === 0) {
      return
    }
    this.topLevel.delete(toolUseId)
    this.topLevel.add(toolUseId)
    while (this.topLevel.size > MAX_TOP_LEVEL_TOOL_IDS) {
      const oldest = this.topLevel.values().next()
      if (oldest.done || oldest.value === toolUseId) {
        break
      }
      this.topLevel.delete(oldest.value)
    }
  }

  /** Record a tool call journaled by a CHILD, against the reference that names
   *  the child. The reference, not an identity: the child's own identity may
   *  still be provisional here, and is resolved when a row is stamped. */
  recordChildOwned(toolUseId: string, ownerRef: string): void {
    if (toolUseId.length === 0 || ownerRef.length === 0) {
      return
    }
    this.childOwnerRefs.delete(toolUseId)
    this.childOwnerRefs.set(toolUseId, ownerRef)
    while (this.childOwnerRefs.size > MAX_CHILD_TOOL_ORIGINS) {
      const oldest = this.childOwnerRefs.keys().next()
      if (oldest.done || oldest.value === toolUseId) {
        break
      }
      this.childOwnerRefs.delete(oldest.value)
    }
  }

  has(toolUseId: string): boolean {
    return this.topLevel.has(toolUseId)
  }

  /** The reference naming the child that journaled this tool call, or null when
   *  no child did — either the session's own agent did, or it was never seen. */
  childOwnerRef(toolUseId: string): string | null {
    return this.childOwnerRefs.get(toolUseId) ?? null
  }

  clear(): void {
    this.topLevel.clear()
    this.childOwnerRefs.clear()
  }
}
