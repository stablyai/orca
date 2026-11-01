import {
  CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS,
  evictStaleLeaseEntries
} from './codex-session-migration-recent-exits'

type IgnoredLaunch = { recordedAt: number }

/** Reattached leases outside the shared home need no exit scan. */
export class CodexSessionMigrationIgnoredLaunches {
  private readonly launches = new Map<string, IgnoredLaunch>()

  add(leaseId: string): void {
    const now = Date.now()
    this.launches.delete(leaseId)
    this.launches.set(leaseId, { recordedAt: now })
    evictStaleLeaseEntries(this.launches, now)
  }

  has(leaseId: string): boolean {
    const launch = this.launches.get(leaseId)
    if (!launch) {
      return false
    }
    // Expire missing exits so a reused lease ID cannot swallow a later launch's exit.
    if (Date.now() - launch.recordedAt > CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS) {
      this.launches.delete(leaseId)
      return false
    }
    return true
  }

  delete(leaseId: string): boolean {
    return this.has(leaseId) && this.launches.delete(leaseId)
  }
}
