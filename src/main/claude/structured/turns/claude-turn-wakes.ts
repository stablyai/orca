// The tasks whose finish notifications woke Claude: a turn it then opens on its own names them.

const MAX_WOKEN_BY = 16

export class ClaudeTurnWakes {
  private pending: string[] = []

  /** A task's notification arrived; one delivered into a running turn wakes nothing. */
  observe(taskId: string, turnOpen: boolean): void {
    if (!turnOpen && !this.pending.includes(taskId) && this.pending.length < MAX_WOKEN_BY) {
      this.pending = [...this.pending, taskId]
    }
  }

  /** Taken by the turn that opens next: named only when Claude opened it, not a send. */
  take(opensItself: boolean): { wokenBy?: string[] } {
    const wokenBy = this.pending
    this.pending = []
    return opensItself && wokenBy.length > 0 ? { wokenBy } : {}
  }
}
