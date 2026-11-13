/** Bounded like the hook server's per-pane maps; eviction only forgets an old respawn. */
const MAX_HANDLE_INCARNATIONS = 4096

export class AgentSenderHandleIncarnations {
  private readonly firstIncarnations = new Map<string, string>()
  matches(handle: string, incarnation: string | null): boolean {
    if (!incarnation) {
      return true
    }
    const first = this.firstIncarnations.get(handle)
    if (first === undefined) {
      this.firstIncarnations.set(handle, incarnation)
      if (this.firstIncarnations.size > MAX_HANDLE_INCARNATIONS) {
        const oldest = this.firstIncarnations.keys().next().value
        if (oldest !== undefined) {
          this.firstIncarnations.delete(oldest)
        }
      }
    }
    return first === undefined || first === incarnation
  }
}
