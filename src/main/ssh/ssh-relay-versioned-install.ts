// Versioned-install plumbing for the remote relay: each (RELAY_VERSION + content-hash)
// bundle installs into its own immutable dir (like VS Code's ~/.vscode-server/bin/<commit>/)
// so an in-memory daemon never serves new clients off overwritten on-disk code.
//
// See: docs/ssh-relay-versioned-install-dirs.md

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { probeInstallLockExistsCommand } from './ssh-relay-install-lock-commands'
import { isRelayInstallLockStale, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import {
  isRelayGcClaimOwned,
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim
} from './ssh-relay-gc-claim'
import { cleanupRelayGcTombstones } from './ssh-relay-gc-tombstone'
import {
  listRelayBaseDirsCommand,
  moveRemoteTreeCommand,
  probeFileExistsCommand,
  probeRelayInstalledCommand,
  relayLivenessProbeCommand,
  removeRemoteTreeCommand,
  writeRemoteEmptyFileCommand
} from './ssh-remote-commands'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  type RemoteHostPlatform,
  type RemotePathFlavor
} from './ssh-remote-platform'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { isSshSessionLimitError } from './ssh-session-limit-error'

// Single source of truth for GC and the version-dir parser; matches both the new and legacy relay-dir layouts.
const RELAY_VERSION_DIR_REGEX = /^relay-(v?\d+\.\d+\.\d+(\+[0-9a-f]+)?)$/

// Legacy dirs predate `.install-complete`; they need a liveness-only GC check so they eventually drain.
const LEGACY_RELAY_DIR_REGEX = /^relay-v\d+\.\d+\.\d+$/

const INSTALL_COMPLETE_NAME = '.install-complete'
const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

type RelayInstalledProbeOptions = {
  rethrowSessionLimitErrors?: boolean
  signal?: AbortSignal
}

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  options?: { signal?: AbortSignal }
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: host.commandDialect !== 'powershell',
    signal: options?.signal
  })
}

/**
 * Read the local relay's content-hashed version (e.g. "0.1.0+0a5fe134d020") from
 * `${localRelayDir}/.version`. Throws on missing/empty so the caller can't
 * silently fall back to a path where a stale-generation daemon may be running.
 */
export function readLocalFullVersion(localRelayDir: string): string {
  const versionFile = join(localRelayDir, '.version')
  if (!existsSync(versionFile)) {
    throw new Error(
      `Orca's local relay build is missing its version marker at ${versionFile}. ` +
        `This usually indicates a packaging or build problem; reinstall Orca.`
    )
  }
  const v = readFileSync(versionFile, 'utf-8').trim()
  if (!v) {
    throw new Error(
      `Orca's local relay version marker at ${versionFile} is empty. ` +
        `This usually indicates a packaging or build problem; reinstall Orca.`
    )
  }
  return v
}

/**
 * Compute the absolute remote install directory for a given content-hashed
 * version. The format is `${remoteHome}/${RELAY_REMOTE_DIR}/relay-${fullVersion}`.
 */
export function computeRemoteRelayDir(
  remoteHome: string,
  fullVersion: string,
  pathFlavor: RemotePathFlavor = 'posix'
): string {
  const host =
    pathFlavor === 'windows'
      ? getRemoteHostPlatform('win32-x64')
      : getRemoteHostPlatform('linux-x64')
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, `relay-${fullVersion}`)
}

/**
 * Probe whether a fully-installed relay exists at remoteRelayDir — meaning
 * relay.js, its relay-watcher.js child, and the .install-complete sentinel are
 * all present. Missing artifacts force a complete re-deploy.
 */
export async function isRelayAlreadyInstalled(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: RelayInstalledProbeOptions
): Promise<boolean> {
  try {
    const probe = await execHostCommand(
      conn,
      host,
      probeRelayInstalledCommand(host, remoteRelayDir),
      { signal: options?.signal }
    )
    return probe.trim() === 'OK'
  } catch (err) {
    options?.signal?.throwIfAborted()
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    return false
  }
}

/**
 * Mark the install complete, then normally release the lock. Deploy keeps the
 * lock through first launch so cross-version GC can't move the dir before daemon
 * liveness is observable.
 */
export async function finalizeInstall(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: { signal?: AbortSignal; releaseLock?: boolean }
): Promise<void> {
  const sentinel = joinRemotePath(host, remoteRelayDir, INSTALL_COMPLETE_NAME)
  const lock = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)
  await execHostCommand(conn, host, writeRemoteEmptyFileCommand(host, sentinel), {
    signal: options?.signal
  })
  if (options?.releaseLock !== false) {
    await execHostCommand(conn, host, removeRemoteTreeCommand(host, lock), {
      signal: options?.signal
    }).catch(() => {})
  }
  options?.signal?.throwIfAborted()
}

/**
 * Release the install lock without writing the completion sentinel, leaving the
 * dir as a recoverable partial the next deploy re-installs.
 */
export async function abandonInstall(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<void> {
  const lock = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)
  await execHostCommand(conn, host, removeRemoteTreeCommand(host, lock)).catch(() => {})
}

/**
 * Garbage-collect old version directories: remove an idle, fully-installed,
 * unlocked sibling version dir (never the current one). Best-effort — errors
 * are swallowed so GC never blocks the user from connecting.
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
  const baseDir = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
  const currentDirName = remoteBasename(currentDirAbsPath, host)
  let listing: string
  try {
    listing = await execHostCommand(conn, host, listRelayBaseDirsCommand(host, baseDir))
  } catch {
    return
  }
  const entries = listing
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  await cleanupRelayGcTombstones(conn, baseDir, entries, host)

  const candidates = entries
    .filter((name) => RELAY_VERSION_DIR_REGEX.test(name))
    .filter((name) => name !== currentDirName)

  if (candidates.length === 0) {
    return
  }

  const removed: string[] = []
  const kept: string[] = []
  for (const name of candidates) {
    const dir = joinRemotePath(host, baseDir, name)
    try {
      const safe = await isCandidateSafeToRemove(conn, dir, name, host, options)
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
        if (!(await isCandidateSafeToRemove(conn, dir, name, host, options))) {
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
        `[ssh-relay] GC failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`
      )
      kept.push(name)
    }
  }

  if (removed.length > 0) {
    const keptSuffix = kept.length > 0 ? ` (kept: ${kept.join(', ')})` : ''
    console.log(
      `[ssh-relay] GC: removed ${removed.length} stale version dir(s): ${removed.join(', ')}${keptSuffix}`
    )
  }
}

async function isCandidateSafeToRemove(
  conn: SshConnection,
  dir: string,
  name: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: {
    windowsNodePath?: string
    windowsSockNames?: string[]
  }
): Promise<boolean> {
  const isLegacy = LEGACY_RELAY_DIR_REGEX.test(name)

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
    process.stderr.write?.(`[ssh-relay] GC: lock at ${lockDir} is stale; treating as recoverable\n`)
  }

  // Legacy dirs predate .install-complete; skip the sentinel and rely on the live-socket probe alone.
  if (!isLegacy) {
    const completePath = joinRemotePath(host, dir, INSTALL_COMPLETE_NAME)
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

  const sockAlive = await hasLiveRelaySocket(conn, dir, host, options)
  if (sockAlive) {
    return false
  }
  return true
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
