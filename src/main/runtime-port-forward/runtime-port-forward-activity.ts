/**
 * When this computer last used a host through a forward: a new connection, or traffic a
 * ForwardUseMeter reads as someone using one (not keepalives). Feeds idle sleep for cloud VMs.
 */
export class RuntimePortForwardActivity {
  private readonly lastUsedAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  note(environmentId: string): number {
    const at = this.now()
    this.lastUsedAt.set(environmentId, at)
    return at
  }

  lastAt(environmentId: string): number | null {
    return this.lastUsedAt.get(environmentId) ?? null
  }

  forget(environmentId: string): void {
    this.lastUsedAt.delete(environmentId)
  }
}
