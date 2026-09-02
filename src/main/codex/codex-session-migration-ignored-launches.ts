import {
  CODEX_SESSION_MIGRATION_LEASE_RETENTION_MS,
  evictStaleLeaseEntries
} from './codex-session-migration-recent-exits'

type IgnoredLaunch = { recordedAt: number }

/** Lease ids whose reattach was proven away from the shared home, so their exit owes no scan. */
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
    // Why: an entry whose exit never arrived must age out, or it absorbs a later exit and strands that launch active.
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
