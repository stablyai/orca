/**
 * The version-directory garbage collector orcad runs. A pass only ever sees, and only ever
 * deletes, directories belonging to `model`.
 *
 * Relay version dirs (`relay-<v>/`) are never reclaimed by this build: nothing deletes them
 * until the relay-era upgrade window closes.
 */
import type { RemoteInstallTransport } from './remote-install-transport'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { probeInstallLockExistsCommand } from './remote-install-lock-commands'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { isRelayInstallLockStale } from './remote-install-lock'
import {
  remoteInstallGcPermits,
  remoteInstallVersionDirRegex,
  type RemoteInstallModel
} from './remote-install-model'
import {
  isRelayGcClaimOwned,
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim
} from './remote-install-gc-claim'
import { cleanupRemoteInstallGcTombstones } from './remote-install-gc-tombstone'
import {
  listRemoteInstallBaseDirsCommand,
  MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES,
  moveRemoteTreeCommand,
  probeFileExistsCommand,
  removeRemoteTreeCommand
} from '../../ssh/ssh-remote-commands'
import {
  getRemoteHostPlatform,
  joinRemotePath,
  remoteBasename,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

type RemoteInstallGcOptions = {
  /**
   * Model-specific "someone is using this directory" probe. It must answer TRUE when
   * inconclusive — an unanswered probe is never evidence a tree is idle.
   */
  isDirLive: (dir: string) => Promise<boolean>
  /**
   * Directories this pass must never remove even when idle and complete, named by directory
   * (not absolute path). orcad passes its active and previous versions: the previous one is
   * the rollback target, and GC'ing it turns a recoverable bad update into a re-deploy.
   */
  pinnedDirNames?: readonly string[]
  /**
   * More pins, resolved only once a candidate exists, given those candidates. Null means the
   * host could not say which directories to keep, so this pass deletes nothing.
   */
  resolveExtraPinnedDirNames?: (candidates: readonly string[]) => Promise<readonly string[] | null>
}

/**
 * Garbage-collect one model's old version directories.
 *
 * **GC ownership (design D10; to be tracked in docs/reference/remote-server-install-model.md):**
 * a pass only ever sees, and only ever deletes, directories belonging to `model`. The remote
 * listing is scoped by prefix, and
 * `remoteInstallGcPermits` re-checks every candidate locally, so neither a widened glob nor
 * a hand-rolled listing can make one model delete the other's live install.
 */
export async function gcOldRemoteInstallVersions(
  conn: RemoteInstallTransport,
  model: RemoteInstallModel,
  remoteHome: string,
  currentDirAbsPath: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options: RemoteInstallGcOptions
): Promise<void> {
  const baseDir = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
  const currentDirName = remoteBasename(currentDirAbsPath, host)
  let listing: string
  try {
    listing = await execHostCommand(
      conn,
      host,
      listRemoteInstallBaseDirsCommand(host, baseDir, model)
    )
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return
  }
  const entries = listing
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES)

  await cleanupRemoteInstallGcTombstones(conn, model, baseDir, entries, host)

  const versionDirRegex = remoteInstallVersionDirRegex(model)
  const pinned = new Set([currentDirName, ...(options.pinnedDirNames ?? [])])
  const candidates = entries
    // Why re-check ownership after a prefix-scoped listing: this is the one line that stands
    // between a parameterized GC and deleting the sibling model's live install.
    .filter((name) => remoteInstallGcPermits(model, name))
    .filter((name) => versionDirRegex.test(name))
    .filter((name) => !pinned.has(name))

  if (candidates.length === 0) {
    return
  }
  const extraPins = options.resolveExtraPinnedDirNames
    ? await options.resolveExtraPinnedDirNames(candidates)
    : []
  if (!extraPins) {
    return
  }
  const survivors = candidates.filter((name) => !extraPins.includes(name))

  const removed: string[] = []
  const kept: string[] = []
  for (const name of survivors) {
    const dir = joinRemotePath(host, baseDir, name)
    try {
      const safe = await isCandidateSafeToRemove(conn, model, dir, host, options)
      if (!safe) {
        kept.push(name)
        continue
      }
      // Why: the claim is a sibling, so it survives moving/deleting the candidate and lets installers back out first.
      const gcClaimToken = await tryAcquireRelayGcClaim(conn, dir, host)
      if (!gcClaimToken) {
        kept.push(name)
        continue
      }
      let preserveGcClaim = false
      let gcClaimReleaseNeeded = true
      try {
        // Recheck under the stable claim; installers probe it before and after creating their lock, closing both orders.
        if (!(await isCandidateSafeToRemove(conn, model, dir, host, options))) {
          kept.push(name)
          continue
        }
        if (!(await isRelayGcClaimOwned(conn, dir, gcClaimToken, host))) {
          kept.push(name)
          continue
        }
        const tombstone = `${dir}.gc-tombstone.${process.pid}.${Date.now()}`
        const moved = await execHostCommand(conn, host, moveRemoteTreeCommand(host, dir, tombstone))
        if (moved.trim() !== 'MOVED') {
          kept.push(name)
          continue
        }
        // Once renamed, a fresh install at the original path is isolated from the tombstone's deletion, so release the claim.
        const release = await releaseRelayGcClaimWithRetry(conn, dir, gcClaimToken, host)
        gcClaimReleaseNeeded = release === 'unknown'
        await execHostCommand(conn, host, removeRemoteTreeCommand(host, tombstone))
      } catch (err) {
        if (isUnconfirmedSshCommandTermination(err)) {
          preserveGcClaim = true
        }
        throw err
      } finally {
        if (!preserveGcClaim && gcClaimReleaseNeeded) {
          await releaseRelayGcClaimWithRetry(conn, dir, gcClaimToken, host)
        }
      }
      removed.push(name)
    } catch (err) {
      if (isUnconfirmedSshCommandTermination(err)) {
        throw err
      }
      console.warn(
        `[${model.id}] GC failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`
      )
      kept.push(name)
    }
  }

  if (removed.length > 0) {
    const keptSuffix = kept.length > 0 ? ` (kept: ${kept.join(', ')})` : ''
    console.log(
      `[${model.id}] GC: removed ${removed.length} stale version dir(s): ${removed.join(', ')}${keptSuffix}`
    )
  }
}

async function isCandidateSafeToRemove(
  conn: RemoteInstallTransport,
  model: RemoteInstallModel,
  dir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options: RemoteInstallGcOptions
): Promise<boolean> {
  const lockDir = joinRemotePath(host, dir, RELAY_INSTALL_LOCK_NAME)
  let lockProbe: string
  try {
    lockProbe = await execHostCommand(conn, host, probeInstallLockExistsCommand(host, lockDir))
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return false
  }
  const lockState = lockProbe.trim()
  if (lockState !== 'OPEN' && lockState !== 'LOCKED') {
    return false
  }
  const locked = lockState === 'LOCKED'

  if (locked) {
    // Why: stale lock = crashed installer; finalize can leave a dir .install-complete yet locked (lock-rm failed), so it's reclaimable.
    if (!(await isRelayInstallLockStale(conn, lockDir, host))) {
      return false
    }
    process.stderr.write?.(
      `[${model.id}] GC: lock at ${lockDir} is stale; treating as recoverable\n`
    )
  }

  const completePath = joinRemotePath(host, dir, model.installCompleteFilename)
  const completeProbe = await execHostCommand(
    conn,
    host,
    probeFileExistsCommand(host, completePath)
  ).catch((err) => {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return 'PARTIAL'
  })
  if (completeProbe.trim() !== 'COMPLETE') {
    // Crashed-install partial; leave for the next deploy to recover.
    return false
  }

  return !(await options.isDirLive(dir))
}
