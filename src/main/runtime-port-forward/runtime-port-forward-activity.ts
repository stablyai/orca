// Same bar as SSH sessions: real use sends more than an idle page's keepalives.
const ACTIVE_BYTES_PER_MINUTE = 2 * 1024

/**
 * When this computer last used a host through a forward: a new connection, or at least
 * ACTIVE_BYTES_PER_MINUTE sent to it within a minute. Feeds idle sleep for cloud VMs.
 */
export class RuntimePortForwardActivity {
  private readonly byEnvironment = new Map<
    string,
    { windowStart: number; bytes: number; at: number }
  >()

  constructor(private readonly now: () => number = Date.now) {}

  note(environmentId: string, bytes: number, connection: boolean): void {
    const now = this.now()
    let entry = this.byEnvironment.get(environmentId)
    if (!entry || now - entry.windowStart >= 60_000) {
      entry = { windowStart: now, bytes: 0, at: entry?.at ?? 0 }
      this.byEnvironment.set(environmentId, entry)
    }
    entry.bytes += bytes
    if (connection || entry.bytes >= ACTIVE_BYTES_PER_MINUTE) {
      entry.at = now
    }
  }

  lastAt(environmentId: string): number | null {
    const at = this.byEnvironment.get(environmentId)?.at
    return at ? at : null
  }

  forget(environmentId: string): void {
    this.byEnvironment.delete(environmentId)
  }
}
