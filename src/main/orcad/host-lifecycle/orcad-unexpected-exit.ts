import { uptime } from 'node:os'
import type { OrcadUnexpectedExit } from '../../../shared/orcad-unexpected-exit'
import type { OrcadLockRecord } from '../instance-lock/orcad-instance-lock-record'

/** A reclaimed orcad lock from this boot means that run died; without boot evidence a reboot cannot be ruled out. */
export function reclaimedUnexpectedExit(
  holder: OrcadLockRecord,
  self: Pick<OrcadLockRecord, 'bootId'>,
  // Linux reads the kernel boot time; elsewhere the OS uptime gives it.
  bootStartedAtMs: number = Date.now() - uptime() * 1000
): OrcadUnexpectedExit | null {
  const sameBoot =
    holder.bootId && self.bootId
      ? holder.bootId === self.bootId
      : Date.parse(holder.acquiredAt) >= bootStartedAtMs
  return holder.role !== 'desktop' && sameBoot
    ? { pid: holder.pid, version: holder.version, acquiredAt: holder.acquiredAt }
    : null
}

let previousUnexpectedExit: OrcadUnexpectedExit | null = null
let runFailed = false

/** A fatal stop keeps the instance lock, so the next start reports this run as unexpected. */
export function markOrcadRunFailed(): void {
  runFailed = true
}

export function orcadRunFailed(): boolean {
  return runFailed
}

/** Set once from the startup lock acquisition, before readiness publishes health. */
export function recordOrcadPreviousUnexpectedExit(exit: OrcadUnexpectedExit | null): void {
  previousUnexpectedExit = exit
}

export function orcadPreviousUnexpectedExit(): OrcadUnexpectedExit | null {
  return previousUnexpectedExit
}
