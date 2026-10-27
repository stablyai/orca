import { createHash, randomUUID } from 'node:crypto'
import type { PtyProcessCeilingState } from '../../shared/pty-process-ceiling-state'
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
import { resolveDaemonUnixSocketPath } from './daemon-socket-endpoint-path'
import { DaemonCrashLoopError, DaemonRespawnThrottle } from './daemon-respawn-throttle'

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
  /** Detected systemd scope; null means none, absent means legacy or adoption metadata. */
  cgroupUnit?: string | null
  processCeiling?: PtyProcessCeilingState
}

export type DaemonProcessHandle = {
  mode?: 'degraded-new-pty-fallback'
  /** Fresh terminals stay off this daemon until a new incarnation replaces it. */
  quarantine?: 'host-image-severed'
  adopted?: true
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
  respawnThrottle?: DaemonRespawnThrottle
  /** Retain the launch policy across restarts that reuse this spawner. */
  staleDaemonRecycleVersion?: string | null
}

export class DaemonSpawner {
  private runtimeDir: string
  private launcher: DaemonLauncher
  private handle: DaemonProcessHandle | null = null
  private socketPath: string
  private tokenPath: string
  private pidPath: string
  private respawnThrottle: DaemonRespawnThrottle
  readonly staleDaemonRecycleVersion: string | null

  constructor(opts: DaemonSpawnerOptions) {
    this.runtimeDir = opts.runtimeDir
    this.staleDaemonRecycleVersion = opts.staleDaemonRecycleVersion ?? null
    this.launcher = opts.launcher
    this.respawnThrottle = opts.respawnThrottle ?? new DaemonRespawnThrottle()
    this.socketPath = getDaemonSocketPath(this.runtimeDir)
    this.tokenPath = getDaemonTokenPath(this.runtimeDir)
    this.pidPath = getDaemonPidPath(this.runtimeDir)
  }

  async ensureRunning(): Promise<DaemonConnectionInfo> {
    if (this.handle) {
      return { socketPath: this.socketPath, tokenPath: this.tokenPath }
    }

    // Gate every launch path so initial starts and explicit restarts cannot bypass crash-loop throttling.
    const admission = this.respawnThrottle.admit()
    if (!admission.allowed) {
      throw new DaemonCrashLoopError(admission)
    }

    // A launch nonce prevents detached cleanup from deleting a replacement's PID record.
    this.handle = await this.launcher(this.socketPath, this.tokenPath, this.pidPath, randomUUID())

    return { socketPath: this.socketPath, tokenPath: this.tokenPath }
  }

  getHandle(): DaemonProcessHandle | null {
    return this.handle
  }

  // Forget a dead process so ensureRunning can launch its replacement.
  resetHandle(): void {
    this.handle = null
  }

  /** A successful fork can still crash immediately; only an explicit restart clears the throttle. */
  resetRespawnWindow(): void {
    this.respawnThrottle.reset()
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
  // Version the Windows pipe to exclude daemons with incompatible protocols.
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
    return `\\\\?\\pipe\\orca-terminal-host-v${protocolVersion}-${suffix}`
  }
  return resolveDaemonUnixSocketPath(runtimeDir, `daemon-v${protocolVersion}.sock`)
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

/** Avoid released age-only sweeper patterns: a claim may hold the sole copy of a live owner's record. */
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
    // Windows file locks can deny rename; only ENOENT permits publishing without a claim.
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
  // Legacy records lack nonces, so their cleanup can only match the PID.
  expectedLaunchNonce: string | null
): boolean {
  return claimAndUnlinkOwnedFile(pidPath, (content) => {
    try {
      const parsed: unknown = JSON.parse(content.trim())
      // Accept legacy integer records so stale ownership cannot block exclusive publication.
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

/** Claim before checking content so concurrent valid replacements survive cleanup. */
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
    // Claim this entry before inspection; later canonical replacements must survive cleanup.
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
    // Preserve ownership evidence when validation fails.
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
    copyExclusive(claimedPath, canonicalPath)
    return true
  } catch (error) {
    // Failed copies may leave partial files; only EEXIST proves a prior canonical replacement.
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST' &&
      canonicalExists(canonicalPath)
    )
  }
}
