/**
 * The version-directory garbage collector, shared by the relay and orcad.
 *
 * It lives apart from `ssh-relay-versioned-install.ts` because it is the one piece both
 * models run, and because the ownership rule below is the whole point of separating them:
 * a pass only ever sees, and only ever deletes, directories belonging to `model`.
 */
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { probeInstallLockExistsCommand } from './ssh-relay-install-lock-commands'
import { isRelayInstallLockStale, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import {
  RELAY_INSTALL_MODEL,
  remoteInstallGcPermits,
  remoteInstallVersionDirRegex,
  type RemoteInstallModel
} from './remote-install-model'
import {
  isRelayGcClaimOwned,
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim
} from './ssh-relay-gc-claim'
import { cleanupRelayGcTombstones } from './ssh-relay-gc-tombstone'
import {
  listRemoteInstallBaseDirsCommand,
  MAX_RELAY_GC_LISTING_ENTRIES,
  moveRemoteTreeCommand,
  probeFileExistsCommand,
  relayLivenessProbeCommand,
  removeRemoteTreeCommand
} from './ssh-remote-commands'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'

// Legacy relay dirs predate `.install-complete`; they need a liveness-only GC check so they
// eventually drain. There is no orcad equivalent — orcad has never shipped without one.
const LEGACY_RELAY_DIR_REGEX = /^relay-v\d+\.\d+\.\d+$/
const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string
): Promise<string> {
  return execCommand(conn, command, { wrapCommand: host.commandDialect !== 'powershell' })
}

export type RemoteInstallGcOptions = {
  windowsNodePath?: string
  windowsSockNames?: string[]
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
}

/**
 * Garbage-collect one model's old version directories.
 *
 * **GC ownership (design §06 falsifier 1):** a pass only ever sees, and only ever deletes,
 * directories belonging to `model`. The remote listing is scoped by prefix, and
 * `remoteInstallGcPermits` re-checks every candidate locally, so neither a widened glob nor
 * a hand-rolled listing can make one model delete the other's live install.
 */
export async function gcOldRemoteInstallVersions(
  conn: SshConnection,
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
  } catch {
    return
  }
  const entries = listing
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_RELAY_GC_LISTING_ENTRIES)

  await cleanupRelayGcTombstones(conn, baseDir, entries, host)

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

  const removed: string[] = []
  const kept: string[] = []
  for (const name of candidates) {
    const dir = joinRemotePath(host, baseDir, name)
    try {
      const safe = await isCandidateSafeToRemove(conn, model, dir, name, host, options)
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
        if (!(await isCandidateSafeToRemove(conn, model, dir, name, host, options))) {
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
  conn: SshConnection,
  model: RemoteInstallModel,
  dir: string,
  name: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options: RemoteInstallGcOptions
): Promise<boolean> {
  const isLegacy = model.id === 'relay' && LEGACY_RELAY_DIR_REGEX.test(name)

  const lockDir = joinRemotePath(host, dir, RELAY_INSTALL_LOCK_NAME)
  let lockProbe: string
  try {
    lockProbe = await execHostCommand(conn, host, probeInstallLockExistsCommand(host, lockDir))
  } catch {
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
    process.stderr.write?.(`[${model.id}] GC: lock at ${lockDir} is stale; treating as recoverable\n`)
  }

  // Legacy dirs predate .install-complete; skip the sentinel and rely on the live-socket probe alone.
  if (!isLegacy) {
    const completePath = joinRemotePath(host, dir, model.installCompleteFilename)
    const completeProbe = await execHostCommand(
      conn,
      host,
      probeFileExistsCommand(host, completePath)
    ).catch(() => 'PARTIAL')
    if (completeProbe.trim() !== 'COMPLETE') {
      // Crashed-install partial; leave for the next deploy to recover.
      return false
    }
  }

  return !(await options.isDirLive(dir))
}


/**
 * The relay's GC, bound to its own namespace and its own liveness probe (a live unix socket
 * or Windows pipe inside the version dir).
 */
export async function gcOldRelayVersions(
  conn: SshConnection,
  remoteHome: string,
  currentDirAbsPath: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: {
    windowsNodePath?: string
    windowsSockNames?: string[]
  }
): Promise<void> {
  await gcOldRemoteInstallVersions(conn, RELAY_INSTALL_MODEL, remoteHome, currentDirAbsPath, host, {
    ...options,
    isDirLive: (dir) => hasLiveRelaySocket(conn, dir, host, options)
  })
}

async function hasLiveRelaySocket(
  conn: SshConnection,
  dir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: {
    windowsNodePath?: string
    windowsSockNames?: string[]
  }
): Promise<boolean> {
  try {
    // Why: `test -S` only — a connect-and-close probe would race with a daemon about to idle.
    const windowsOptions =
      isWindowsRemoteHost(host) && options?.windowsNodePath
        ? {
            nodePath: options.windowsNodePath,
            pipePaths: (options.windowsSockNames ?? []).flatMap((sockName) =>
              windowsRelayPipePathsForSocketName(host, dir, sockName)
            )
          }
        : undefined
    const out = await execHostCommand(
      conn,
      host,
      relayLivenessProbeCommand(host, dir, windowsOptions)
    )
    const state = out.trim()
    return state !== 'DEAD' && state !== 'WAITING'
  } catch {
    // Why: an inconclusive liveness probe must never authorize deletion.
    return true
  }
}
