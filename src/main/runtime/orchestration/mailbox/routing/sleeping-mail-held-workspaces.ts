/** Workspaces holding mail for a sleeping pane, counted by pane, with what joined or left since the last take. */
export class SleepingMailHeldWorkspaces {
  private readonly counts = new Map<string, number>()
  private readonly changed = new Set<string>()
  /** Bumped only when a workspace joins or leaves the set. */
  version = 0

  /** A pane's hold moved from `previous` to `next` (either may be none). */
  move(previous: string | undefined, next: string | undefined): void {
    if (previous) {
      const count = (this.counts.get(previous) ?? 1) - 1
      if (count) {
        this.counts.set(previous, count)
      } else {
        this.counts.delete(previous)
        this.flip(previous)
      }
    }
    if (next) {
      const count = (this.counts.get(next) ?? 0) + 1
      this.counts.set(next, count)
      if (count === 1) {
        this.flip(next)
      }
    }
  }

  worktrees(): string[] {
    return [...this.counts.keys()].sort()
  }

  /** The workspaces that joined or left since the last take, by where each ended up. */
  takeChanges(): { held: string[]; released: string[] } {
    const held: string[] = []
    const released: string[] = []
    for (const id of this.changed) {
      ;(this.counts.has(id) ? held : released).push(id)
    }
    this.changed.clear()
    return { held, released }
  }

  private flip(worktreeId: string): void {
    this.version++
    this.changed.add(worktreeId)
  }
}
