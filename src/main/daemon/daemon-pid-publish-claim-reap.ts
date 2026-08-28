// Why no import from daemon-pid-identity: daemon-spawner imports this module, and
// daemon-pid-identity imports daemon-spawner — the errno check is not worth a cycle.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Matches publish scratch for ANY protocol version, current or retired, so a crashed
 * publisher's claim never outlives it the way a torn canonical record for a retired
 * version would. Deliberately never matches `.swap-`/`.hold-` claims: those can hold the
 * only copy of a live daemon's record and are restored by their owners, not reaped.
 */
const PUBLISH_CLAIM_PATTERN = /^daemon-v\d+\.pid\.publish-(\d+)-[0-9a-f-]+$/

/**
 * Why proven death and not age: a claim is only scratch — its content was never canonical —
 * but deleting a LIVE publisher's claim between its write and its link knocks that publish
 * off the atomic path: the link fails non-EEXIST and degrades to the exclusive direct
 * write, which succeeds but reopens the torn-write window this discipline exists to close.
 * Only ESRCH proves the owner is gone; EPERM means it exists under another user,
 * and pid recycling merely preserves junk a little longer, which is the safe direction.
 */
function claimOwnerIsProvenDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
  }
}

/** Best-effort by design: reaping is hygiene, and no failure here may block a launch. */
export function reapOrphanedDaemonPidPublishClaims(runtimeDir: string): void {
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch {
    return
  }
  for (const name of names) {
    const claimOwnerPid = Number(PUBLISH_CLAIM_PATTERN.exec(name)?.[1])
    if (
      !Number.isSafeInteger(claimOwnerPid) ||
      claimOwnerPid <= 0 ||
      claimOwnerPid === process.pid ||
      !claimOwnerIsProvenDead(claimOwnerPid)
    ) {
      continue
    }
    try {
      rmSync(join(runtimeDir, name), { force: true })
    } catch {
      // Still scratch; the next launch tries again.
    }
  }
}
