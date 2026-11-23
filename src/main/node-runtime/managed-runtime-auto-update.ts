// When Orca brings its own copy of a runtime up to date without a click, and how often it retries.

import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import type { ManagedRuntimeOperation } from '../../shared/agent-launch/installation/managed-runtime-install'
import type { InstalledRuntimeReleases, ManagedRuntimePin } from './managed-runtime-release'

const RETRY_MS = 60 * 60_000
const MAX_RETRY_MS = 24 * 60 * 60_000

/** The pinned release, when it is newer than the whole copy launches run; never a downgrade, and a
 *  damaged or republished copy of the same version waits for Update, which repairs it. An
 *  unreadable root may already hold the pin, so it waits too. */
export function pinnedReleaseAhead(
  pin: ManagedRuntimePin | null,
  { release, unreadable }: InstalledRuntimeReleases
): string | null {
  if (!pin || !release || release.current || unreadable) {
    return null
  }
  const newer =
    isValidAppVersion(pin.version) &&
    isValidAppVersion(release.version) &&
    compareAppVersions(pin.version, release.version) > 0
  return newer ? pin.version : null
}

/** One attempt per release, then each retry waits twice as long (up to a day), so an offline host
 *  stays quiet; a Cancel of an automatic update declines that release until Orca next starts. */
export class AutoUpdateBackoff {
  private last: { version: string; at: number; attempts: number; declined: boolean } | null = null
  private running: string | null = null

  /** Whether an attempt at `version` is due now; a due attempt is recorded. */
  due(version: string): boolean {
    const last = this.last?.version === version ? this.last : null
    if (last) {
      const wait = Math.min(RETRY_MS * 2 ** (last.attempts - 1), MAX_RETRY_MS)
      if (last.declined || Date.now() - last.at < wait) {
        return false
      }
    }
    this.last = { version, at: Date.now(), attempts: (last?.attempts ?? 0) + 1, declined: false }
    return true
  }

  started(operationId: string): void {
    this.running = operationId
  }

  settled(operationId: string, phase: ManagedRuntimeOperation['phase']): void {
    if (operationId !== this.running) {
      return
    }
    this.running = null
    if (phase === 'cancelled' && this.last) {
      this.last.declined = true
    }
  }
}
