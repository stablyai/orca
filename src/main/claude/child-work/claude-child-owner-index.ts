// Ownership links a task to the subagent whose spawn call started it, in both directions: the
// children of one owner, and the owner to drop when the task leaves the live set.

import type { DecodedClaudeTask } from './claude-child-work-evidence'

/** Children of an owner, and the owner of a child, kept in step with the live map. */
export class ClaudeChildOwnerIndex {
  private readonly byOwner = new Map<string, Set<string>>()

  clear(): void {
    this.byOwner.clear()
  }

  /** Move `id` under the owner `task` names, forgetting the owner it left with no children. */
  setLive(id: string, task: DecodedClaudeTask, previous: DecodedClaudeTask | undefined): void {
    this.forget(id, previous)
    if (!task.parentTaskId) {
      return
    }
    const children = this.byOwner.get(task.parentTaskId) ?? new Set<string>()
    children.add(id)
    this.byOwner.set(task.parentTaskId, children)
  }

  /** Drop `id` from the owner it was recorded under, forgetting an owner with no children left. */
  forget(id: string, live: DecodedClaudeTask | undefined): void {
    const parent = live?.parentTaskId
    if (parent === undefined) {
      return
    }
    const children = this.byOwner.get(parent)
    children?.delete(id)
    if (children?.size === 0) {
      this.byOwner.delete(parent)
    }
  }

  children(ownerId: string): ReadonlySet<string> {
    return this.byOwner.get(ownerId) ?? new Set<string>()
  }
}
