// Preserve legacy relay directories until the relay-era upgrade window closes.
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
  /** Return true when liveness is inconclusive. */
  isDirLive: (dir: string) => Promise<boolean>
  /** Preserve active and rollback-target directory names even when idle and complete. */
  pinnedDirNames?: readonly string[]
  /** Resolve additional pins lazily; null means uncertain ownership and prevents all deletion. */
  resolveExtraPinnedDirNames?: (candidates: readonly string[]) => Promise<readonly string[] | null>
}

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
    // Recheck ownership after listing to prevent deletion of sibling-model installs.
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
      // Sibling claims survive candidate deletion so installers can still detect and back out of GC.
      const gcClaimToken = await tryAcquireRelayGcClaim(conn, dir, host)
      if (!gcClaimToken) {
        kept.push(name)
        continue
      }
      let preserveGcClaim = false
      let gcClaimReleaseNeeded = true
      try {
        // Installer checks before and after locking close both claim/lock acquisition orders.
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
        // Rename isolates fresh installs from tombstone deletion, so the stable claim can be released.
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
    // Finalization can leave completed installs locked; only stale locks permit collection.
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
    // Leave crashed partial installs for deploy recovery.
    return false
  }

  return !(await options.isDirLive(dir))
}
