// Top-level calls gate task-row admission; child-owned calls identify grandchildren's parents.

/** Bound stores independently so child traffic cannot evict top-level spawn evidence. */
const MAX_TOP_LEVEL_TOOL_IDS = 512
const MAX_CHILD_TOOL_ORIGINS = 512

export class ClaudeToolOriginRegistry {
  private readonly topLevel = new Set<string>()
  private readonly childOwnerRefs = new Map<string, string>()

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

  /** Retain the owner reference so provisional child identity can resolve when stamping rows. */
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

  /** Null means a root-owned or unseen call. */
  childOwnerRef(toolUseId: string): string | null {
    return this.childOwnerRefs.get(toolUseId) ?? null
  }

  clear(): void {
    this.topLevel.clear()
    this.childOwnerRefs.clear()
  }
}
