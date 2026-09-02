export const CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS = 60_000
const MAX_ENTRIES = 256

type RecentPtyExit = { sequence: number; recordedAt: number }

// Why: one aging policy for every lease-keyed migration map, so none can grow for the process lifetime.
export function evictStaleLeaseEntries<T extends { recordedAt: number }>(
  entries: Map<string, T>,
  now: number
): void {
  for (const [leaseId, entry] of entries) {
    if (now - entry.recordedAt > CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS) {
      entries.delete(leaseId)
    }
  }
  while (entries.size > MAX_ENTRIES) {
    const oldestLeaseId = entries.keys().next().value
    if (oldestLeaseId === undefined) {
      break
    }
    entries.delete(oldestLeaseId)
  }
}

export class CodexSessionMigrationRecentExits {
  private readonly exits = new Map<string, RecentPtyExit>()

  record(leaseId: string, sequence: number): void {
    const now = Date.now()
    this.exits.delete(leaseId)
    this.exits.set(leaseId, { sequence, recordedAt: now })
    evictStaleLeaseEntries(this.exits, now)
  }

  consumeAfter(leaseId: string, startedSequence: number | undefined): RecentPtyExit | null {
    const exit = this.exits.get(leaseId)
    this.exits.delete(leaseId)
    if (
      !exit ||
      startedSequence === undefined ||
      exit.sequence <= startedSequence ||
      Date.now() - exit.recordedAt > CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS
    ) {
      return null
    }
    return exit
  }

  matchesAfter(leaseId: string, startedSequence: number | undefined): boolean {
    const exit = this.exits.get(leaseId)
    if (!exit) {
      return false
    }
    if (Date.now() - exit.recordedAt > CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS) {
      this.exits.delete(leaseId)
      return false
    }
    return startedSequence !== undefined && exit.sequence > startedSequence
  }
}
