import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './types'

export type DaemonConnectionInfo = {
  socketPath: string
  tokenPath: string
}

export type DaemonPidFile = {
  pid: number
  startedAtMs: number | null
  entryPath?: string
  appVersion?: string
  launchNonce?: string
  linuxStartTicks?: string
  bootId?: string
  /** Forking app's binary — macOS pins the daemon's TCC responsible process to it (STA-3491). */
  spawnerExecPath?: string
}

/**
 * 'degraded-new-pty-fallback' — adopted, but it cannot spawn fresh PTYs.
 * 'held' — deliberately kept without adopting it, because replacing it might end live work:
 * either it demonstrably owns terminals and cannot answer a handshake, or it could not be
 * classified at all. Both mean there is no lease to take, and none must be attempted.
 */
export type DaemonLaunchMode = 'degraded-new-pty-fallback' | 'held'

export type DaemonProcessHandle = {
  mode?: DaemonLaunchMode
  releaseAdoptionLease?(): void
  shutdown(): Promise<void>
}

export type DaemonLauncher = (
  socketPath: string,
  tokenPath: string,
  pidPath?: string,
  launchNonce?: string
) => Promise<DaemonProcessHandle>

export type DaemonSpawnerOptions = {
  runtimeDir: string
  launcher: DaemonLauncher
}

export class DaemonSpawner {
  private runtimeDir: string
  private launcher: DaemonLauncher
  private handle: DaemonProcessHandle | null = null
  private socketPath: string
  private tokenPath: string
  private pidPath: string

  constructor(opts: DaemonSpawnerOptions) {
    this.runtimeDir = opts.runtimeDir
    this.launcher = opts.launcher
    this.socketPath = getDaemonSocketPath(this.runtimeDir)
    this.tokenPath = getDaemonTokenPath(this.runtimeDir)
    this.pidPath = getDaemonPidPath(this.runtimeDir)
  }

  async ensureRunning(): Promise<DaemonConnectionInfo> {
    if (this.handle) {
      return { socketPath: this.socketPath, tokenPath: this.tokenPath }
    }

    // Why: a detached daemon may clean up after its parent exits. A unique
    // launch identity keeps it from deleting a replacement daemon's PID file.
    this.handle = await this.launcher(this.socketPath, this.tokenPath, this.pidPath, randomUUID())

    return { socketPath: this.socketPath, tokenPath: this.tokenPath }
  }

  getHandle(): DaemonProcessHandle | null {
    return this.handle
  }

  // Why: after the daemon process dies unexpectedly, the cached handle is
  // stale. Clearing it lets the next ensureRunning() fork a fresh daemon
  // instead of returning the dead socket path.
  resetHandle(): void {
    this.handle = null
  }

  async shutdown(): Promise<void> {
    if (!this.handle) {
      return
    }
    const handle = this.handle
    this.handle = null
    await handle.shutdown()
  }
}

export function getDaemonSocketPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  // Why: Windows IPC servers use named pipes rather than filesystem socket
  // files. Include the protocol version in the endpoint name so a daemon from
  // an older build is never reused after a breaking protocol change.
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
    return `\\\\?\\pipe\\orca-terminal-host-v${protocolVersion}-${suffix}`
  }
  return join(runtimeDir, `daemon-v${protocolVersion}.sock`)
}

export function getDaemonTokenPath(runtimeDir: string, protocolVersion = PROTOCOL_VERSION): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.token`)
}

export function getDaemonPidPath(runtimeDir: string, protocolVersion = PROTOCOL_VERSION): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.pid`)
}

export function serializeDaemonPidFile(pidFile: DaemonPidFile): string {
  return JSON.stringify(pidFile)
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function publishDaemonPidFile(pidPath: string, pidFile: DaemonPidFile): void {
  writeFileSync(pidPath, serializeDaemonPidFile(pidFile), {
    mode: 0o600,
    flag: 'wx'
  })
}

/**
 * Scratch names for the two claim protocols.
 *
 * Why `.swap`/`.hold` and not the `.cleanup`/`.replace` these once were: released builds carry a
 * sweeper matching `\.(?:cleanup|replace)-\d+-<uuid>$` that deletes on age alone, with no
 * liveness or ownership check. A claim briefly holds the ONLY copy of a live daemon's token or
 * PID record, so an old build starting while a claimant is paused would destroy it with no way
 * to restore. Exported so a test can pin them against that released pattern.
 */
export function getDaemonPidSwapClaimPath(pidPath: string): string {
  return `${pidPath}.swap-${process.pid}-${randomUUID()}`
}

export function getDaemonArtifactHoldClaimPath(filePath: string): string {
  return `${filePath}.hold-${process.pid}-${randomUUID()}`
}

export function replaceDaemonPidFile(pidPath: string, pidFile: DaemonPidFile): boolean {
  const claimedPath = getDaemonPidSwapClaimPath(pidPath)
  let claimedExisting = false
  try {
    renameSync(pidPath, claimedPath)
    claimedExisting = true
  } catch (error) {
    // Why: only a genuinely absent record is safe to treat as unclaimed. On Windows an
    // external opener without FILE_SHARE_DELETE (AV, indexer, backup) fails the rename
    // with EPERM/EACCES/EBUSY; falling through would then hit EEXIST on the exclusive
    // publish and report a false ownership conflict for a record that is simply locked.
    if (!isMissingFileError(error)) {
      return false
    }
  }

  try {
    publishDaemonPidFile(pidPath, pidFile)
  } catch {
    if (claimedExisting && restoreClaimedDaemonArtifact(claimedPath, pidPath)) {
      try {
        unlinkSync(claimedPath)
      } catch {
        // A uniquely named restored claim is inert.
      }
    }
    return false
  }

  if (claimedExisting) {
    try {
      unlinkSync(claimedPath)
    } catch {
      // The canonical record is authoritative; the uniquely named claim is inert.
    }
  }
  return true
}

export function unlinkOwnedDaemonPidFile(
  pidPath: string,
  expectedPid: number,
  // Why: records written before launch nonces existed carry none. Matching on PID alone is
  // weaker, but it still fences against removing a replacement's record, which is the point.
  expectedLaunchNonce: string | null
): boolean {
  return claimAndUnlinkOwnedFile(pidPath, (content) => {
    try {
      const parsed: unknown = JSON.parse(content.trim())
      // Why: the oldest records are a bare integer, not an object. Rejecting them left the
      // file in place, and the replacement's exclusive publish then failed with EEXIST —
      // trading a stale record for a daemon that cannot start at all.
      if (typeof parsed === 'number') {
        return expectedLaunchNonce === null && parsed === expectedPid
      }
      if (!parsed || typeof parsed !== 'object') {
        return false
      }
      const record = parsed as { pid?: unknown; launchNonce?: unknown }
      if (record.pid !== expectedPid) {
        return false
      }
      return expectedLaunchNonce === null
        ? record.launchNonce === undefined || record.launchNonce === null
        : record.launchNonce === expectedLaunchNonce
    } catch {
      return false
    }
  })
}

/**
 * Removes a PID record whose content still satisfies `matches`, under the same rename claim
 * used for owned records. Lets an unparseable record be reclaimed without risking a valid
 * replacement record that appeared in the meantime.
 */
export function unlinkDaemonPidFileWhen(
  pidPath: string,
  matches: (content: string) => boolean
): boolean {
  return claimAndUnlinkOwnedFile(pidPath, matches)
}

export function unlinkOwnedDaemonTokenFile(tokenPath: string, expectedToken: string): boolean {
  return claimAndUnlinkOwnedFile(tokenPath, (content) => content.trim() === expectedToken)
}

function claimAndUnlinkOwnedFile(
  filePath: string,
  ownsContent: (content: string) => boolean
): boolean {
  const claimedPath = getDaemonArtifactHoldClaimPath(filePath)
  try {
    // Why: rename claims one exact directory entry before inspection, so a replacement
    // installed afterward stays at the canonical path and cannot be unlinked by us.
    renameSync(filePath, claimedPath)
  } catch {
    return false
  }
  try {
    if (ownsContent(readFileSync(claimedPath, 'utf8'))) {
      unlinkSync(claimedPath)
      return true
    }
  } catch {
    // Restore below when the claimed file cannot be validated as ours.
  }

  const restoredOrReplaced = restoreClaimedDaemonArtifact(claimedPath, filePath)
  if (restoredOrReplaced) {
    try {
      unlinkSync(claimedPath)
    } catch {
      // A uniquely named unowned claim is safer to leave than overwriting a replacement.
    }
  }
  return false
}

export function restoreClaimedDaemonArtifact(
  claimedPath: string,
  canonicalPath: string,
  operations: {
    copyExclusive?: (source: string, target: string) => void
    canonicalExists?: (path: string) => boolean
  } = {}
): boolean {
  const copyExclusive =
    operations.copyExclusive ??
    ((source: string, target: string) => copyFileSync(source, target, constants.COPYFILE_EXCL))
  const canonicalExists = operations.canonicalExists ?? existsSync
  try {
    // Why: exclusive restore never overwrites a newer canonical replacement.
    copyExclusive(claimedPath, canonicalPath)
    return true
  } catch (error) {
    // Why: copy failures can leave a partial canonical file. Only EEXIST proves
    // another owner had already installed a replacement before our copy.
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST' &&
      canonicalExists(canonicalPath)
    )
  }
}
