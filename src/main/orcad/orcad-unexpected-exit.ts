import type { OrcadUnexpectedExit } from '../../shared/orcad-unexpected-exit'

type LockHolder = {
  pid: number
  version: string
  acquiredAt: string
  role?: 'orcad' | 'desktop'
  bootId?: string
}

/** A reclaimed orcad lock from this boot means that run died; without boot evidence a reboot cannot be ruled out. */
export function reclaimedUnexpectedExit(
  holder: LockHolder,
  self: { bootId?: string },
  bootStartedAtMs: number | undefined
): OrcadUnexpectedExit | null {
  const sameBoot =
    holder.bootId && self.bootId
      ? holder.bootId === self.bootId
      : bootStartedAtMs !== undefined && Date.parse(holder.acquiredAt) >= bootStartedAtMs
  return holder.role !== 'desktop' && sameBoot
    ? { pid: holder.pid, version: holder.version, acquiredAt: holder.acquiredAt }
    : null
}

let previousUnexpectedExit: OrcadUnexpectedExit | null = null

/** Set once from the startup lock acquisition, before readiness publishes health. */
export function recordOrcadPreviousUnexpectedExit(exit: OrcadUnexpectedExit | null): void {
  previousUnexpectedExit = exit
}

export function orcadPreviousUnexpectedExit(): OrcadUnexpectedExit | null {
  return previousUnexpectedExit
}
