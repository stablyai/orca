/** Per-environment event times within a sliding window, for caps on automatic host actions. */
export class ManagedOrcadEventWindow {
  private readonly events = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number
  ) {}

  /** Oldest first. */
  recent(environmentId: string): number[] {
    const now = this.now()
    return (this.events.get(environmentId) ?? []).filter((at) => now - at < this.windowMs)
  }

  record(environmentId: string): void {
    this.events.set(environmentId, [...this.recent(environmentId), this.now()])
  }

  forget(environmentId: string): void {
    this.events.delete(environmentId)
  }
}
