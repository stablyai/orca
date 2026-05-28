// Versioned-install plumbing for the remote relay.
//
// Why this exists: the relay used to install into a single shared directory
// (~/.orca-remote/relay-v0.1.0) which the deploy step would overwrite in place
// on every cross-version push. A daemon already loaded into memory then served
// new clients off rewritten on-disk code, producing protocol drift and a
// reconnect loop. We now install each (RELAY_VERSION + content-hash) bundle
// into its own directory and never mutate it after the install finishes,
// matching VS Code's `~/.vscode-server/bin/<commit>/` layout.
//
// See: docs/ssh-relay-versioned-install-dirs.md

import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'

// Why: the GC pass and the version-dir parser must agree on what counts as a
// relay install dir. Single source of truth for both. The pattern matches the
// new layout `relay-${RELAY_VERSION}+${hash}` and the legacy `relay-v${VERSION}`
// so the GC eventually drains the old layout once its daemons idle out.
const RELAY_VERSION_DIR_REGEX = /^relay-(v?\d+\.\d+\.\d+(\+[0-9a-f]+)?)$/

// Why: legacy dirs from before `.install-complete` was introduced (i.e. the
// `relay-v0.1.0` shape with no content-hash suffix). They are missing the
// install-complete sentinel by definition and need a separate liveness-only
// GC check so they actually drain after the legacy daemon dies, instead of
// living on remote disks forever.
const LEGACY_RELAY_DIR_REGEX = /^relay-v\d+\.\d+\.\d+$/

const INSTALL_LOCK_NAME = '.install-lock'
const INSTALL_COMPLETE_NAME = '.install-complete'

const INSTALL_LOCK_POLL_MS = 1_000
const INSTALL_LOCK_TIMEOUT_MS = 120_000
// Why: a stale lock dir from a crashed installer must be recoverable without
// user intervention. After the timeout we check the lock's mtime; if it's
// older than this window the previous installer is assumed dead and we steal
// the lock. 2 minutes is well above a normal `npm install node-pty` runtime
// (10–60s on slow hosts) so a slow concurrent installer is not falsely
// declared dead.
const INSTALL_LOCK_STALE_MS = 120_000

/**
 * Read the local relay's content-hashed version (e.g. "0.1.0+0a5fe134d020")
 * from `${localRelayDir}/.version`. Throws on missing/empty so the caller
 * never silently falls back to a path where a daemon from a different code
 * generation may already be running — that fallback is the failure mode the
 * versioned-install design exists to prevent.
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
export function computeRemoteRelayDir(remoteHome: string, fullVersion: string): string {
  return `${remoteHome}/${RELAY_REMOTE_DIR}/relay-${fullVersion}`
}

/**
 * Probe whether a fully-installed relay already exists at remoteRelayDir.
 *
 * "Fully installed" means: the directory exists, contains relay.js, AND
 * contains the .install-complete sentinel written at the end of a successful
 * install. A directory missing .install-complete is either mid-install (lock
 * held) or a crashed-install partial — either way we re-run the deploy.
 */
export async function isRelayAlreadyInstalled(
  conn: SshConnection,
  remoteRelayDir: string
): Promise<boolean> {
  try {
    const probe = await execCommand(
      conn,
      `test -d ${shellEscape(remoteRelayDir)} ` +
        `&& test -f ${shellEscape(`${remoteRelayDir}/relay.js`)} ` +
        `&& test -f ${shellEscape(`${remoteRelayDir}/${INSTALL_COMPLETE_NAME}`)} ` +
        `&& echo OK || echo MISSING`
    )
    return probe.trim() === 'OK'
  } catch {
    return false
  }
}

/**
 * Acquire the per-version install lock via atomic `mkdir`. Returns when the
 * caller owns the lock; throws if the lock could not be acquired within
 * INSTALL_LOCK_TIMEOUT_MS even after one stale-lock recovery attempt.
 *
 * Why mkdir: POSIX `mkdir` is atomic and fails with EEXIST if the dir already
 * exists, giving us a free mutex. A second concurrent caller polls and
 * eventually either acquires the lock or steals it after the stale window.
 */
export async function acquireInstallLock(
  conn: SshConnection,
  remoteRelayDir: string
): Promise<void> {
  const lockDir = `${remoteRelayDir}/${INSTALL_LOCK_NAME}`
  // Why: the parent dir may not exist yet on a first install. mkdir -p is
  // safe to run multiple times — it's a no-op if the dir already exists.
  await execCommand(conn, `mkdir -p ${shellEscape(remoteRelayDir)}`)

  let start = Date.now()
  let recoveredOnce = false
  while (true) {
    try {
      const result = await execCommand(
        conn,
        `mkdir ${shellEscape(lockDir)} 2>&1 && echo OK || echo BUSY`
      )
      if (result.trim().endsWith('OK')) {
        return
      }
    } catch {
      /* mkdir failed with non-zero — fall through to BUSY treatment */
    }
    if (Date.now() - start >= INSTALL_LOCK_TIMEOUT_MS) {
      if (recoveredOnce) {
        throw new Error(
          `Could not acquire relay install lock at ${lockDir} after ${
            INSTALL_LOCK_TIMEOUT_MS / 1000
          }s; another install is in progress or the lock is wedged.`
        )
      }
      // Stale-lock recovery: if the lock dir's mtime is older than the stale
      // window, the previous installer crashed. Steal it and retry once,
      // resetting the timeout window so a single post-recovery race doesn't
      // immediately exhaust the budget.
      const ageOk = await isLockStale(conn, lockDir)
      if (ageOk) {
        console.warn(`[ssh-relay] Stealing stale install lock at ${lockDir}`)
        await execCommand(conn, `rm -rf ${shellEscape(lockDir)}`).catch(() => {})
        recoveredOnce = true
        start = Date.now()
        continue
      }
      throw new Error(
        `Could not acquire relay install lock at ${lockDir} after ${
          INSTALL_LOCK_TIMEOUT_MS / 1000
        }s and the lock is not yet stale.`
      )
    }
    await new Promise((r) => setTimeout(r, INSTALL_LOCK_POLL_MS))
  }
}

async function isLockStale(conn: SshConnection, lockDir: string): Promise<boolean> {
  try {
    // Why: `stat` flags differ between GNU coreutils (Linux) and BSD (macOS).
    // We try GNU first, then BSD; both produce a Unix epoch in seconds on
    // stdout. If both fail we conservatively treat the lock as not stale.
    const out = await execCommand(
      conn,
      `stat -c %Y ${shellEscape(lockDir)} 2>/dev/null || stat -f %m ${shellEscape(lockDir)} 2>/dev/null || echo`
    )
    const mtimeSec = parseInt(out.trim(), 10)
    if (!Number.isFinite(mtimeSec)) {
      return false
    }
    const ageMs = Date.now() - mtimeSec * 1000
    return ageMs > INSTALL_LOCK_STALE_MS
  } catch {
    return false
  }
}

/**
 * Mark the install as complete and release the lock. Sentinel ordering is:
 * write `.install-complete` FIRST, then remove `.install-lock`. This ensures
 * a sibling dir is never observed by GC as "complete but locked", which
 * would lead GC to skip a recoverable dir indefinitely.
 */
export async function finalizeInstall(conn: SshConnection, remoteRelayDir: string): Promise<void> {
  const sentinel = `${remoteRelayDir}/${INSTALL_COMPLETE_NAME}`
  const lock = `${remoteRelayDir}/${INSTALL_LOCK_NAME}`
  await execCommand(conn, `touch ${shellEscape(sentinel)}`)
  await execCommand(conn, `rm -rf ${shellEscape(lock)}`).catch(() => {})
}

/**
 * Release the install lock without writing the completion sentinel. Called
 * from the failure path so the dir remains a recoverable partial that the
 * next deploy detects (alreadyInstalled=false) and re-runs upload+install.
 */
export async function abandonInstall(conn: SshConnection, remoteRelayDir: string): Promise<void> {
  const lock = `${remoteRelayDir}/${INSTALL_LOCK_NAME}`
  await execCommand(conn, `rm -rf ${shellEscape(lock)}`).catch(() => {})
}

/**
 * Garbage-collect old version directories. Removes a sibling dir under
 * `${remoteHome}/${RELAY_REMOTE_DIR}/` only if ALL of:
 *
 *   - it matches the relay-version-dir regex (allowlist)
 *   - it is NOT the current version dir
 *   - it has no live `relay-*.sock` (pgrep + connectability probe)
 *   - it contains `.install-complete` (a fully-installed dir, not a partial)
 *   - it does NOT contain `.install-lock` (no in-progress install)
 *
 * Best-effort: any error is logged and swallowed; GC must never block the
 * user from connecting.
 */
export async function gcOldRelayVersions(
  conn: SshConnection,
  remoteHome: string,
  currentDirAbsPath: string
): Promise<void> {
  const baseDir = `${remoteHome}/${RELAY_REMOTE_DIR}`
  const currentDirName = currentDirAbsPath.split('/').filter(Boolean).pop() ?? ''
  let listing: string
  try {
    listing = await execCommand(conn, `ls -1 ${shellEscape(baseDir)} 2>/dev/null || true`)
  } catch {
    return
  }
  const candidates = listing
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((name) => RELAY_VERSION_DIR_REGEX.test(name))
    .filter((name) => name !== currentDirName)

  if (candidates.length === 0) {
    return
  }

  const removed: string[] = []
  const kept: string[] = []
  for (const name of candidates) {
    const dir = `${baseDir}/${name}`
    try {
      const safe = await isCandidateSafeToRemove(conn, dir, name)
      if (!safe) {
        kept.push(name)
        continue
      }
      await execCommand(conn, `rm -rf ${shellEscape(dir)}`)
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
  name: string
): Promise<boolean> {
  const isLegacy = LEGACY_RELAY_DIR_REGEX.test(name)

  const lockProbe = await execCommand(
    conn,
    `test -d ${shellEscape(`${dir}/${INSTALL_LOCK_NAME}`)} && echo LOCKED || echo OPEN`
  ).catch(() => 'OPEN')
  const locked = lockProbe.trim() === 'LOCKED'

  if (locked) {
    // Why: a locked dir is normally unsafe to remove — but a STALE lock
    // (mtime older than INSTALL_LOCK_STALE_MS) means the previous installer
    // crashed and is never coming back. If the dir also has the
    // .install-complete sentinel (touch succeeded but the rm-lock at the
    // end of finalizeInstall failed), removing the dir is safe — no
    // installer is racing us, and the daemon (if any) keeps running off
    // its already-loaded code regardless of disk state.
    const lockDir = `${dir}/${INSTALL_LOCK_NAME}`
    if (!(await isLockStale(conn, lockDir))) {
      return false
    }
    process.stderr.write?.(`[ssh-relay] GC: lock at ${lockDir} is stale; treating as recoverable\n`)
  }

  // Legacy dirs (relay-v0.1.0) predate .install-complete. Skip the sentinel
  // check for them and rely solely on the live-socket probe — that's the
  // only signal we have that a legacy daemon is still serving clients.
  if (!isLegacy) {
    const completeProbe = await execCommand(
      conn,
      `test -f ${shellEscape(`${dir}/${INSTALL_COMPLETE_NAME}`)} && echo COMPLETE || echo PARTIAL`
    ).catch(() => 'PARTIAL')
    if (completeProbe.trim() !== 'COMPLETE') {
      // Crashed-install partial; leave for the next deploy to recover.
      return false
    }
  }

  const sockAlive = await hasLiveRelaySocket(conn, dir)
  if (sockAlive) {
    return false
  }
  return true
}

async function hasLiveRelaySocket(conn: SshConnection, dir: string): Promise<boolean> {
  try {
    // Why: `ls -1 dir/relay-*.sock 2>/dev/null` lists socket files. For each,
    // we test -S to confirm it's a socket inode. We do NOT attempt to open
    // the socket here — `test -S` is sufficient for the GC decision and a
    // connect-and-close probe would race with a daemon that's about to idle.
    const out = await execCommand(
      conn,
      `for f in ${shellEscape(dir)}/relay-*.sock ${shellEscape(dir)}/relay.sock; do ` +
        `[ -S "$f" ] && echo ALIVE && break; ` +
        `done; true`
    )
    return out.includes('ALIVE')
  } catch {
    return false
  }
}
