import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
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
}

export type DaemonProcessHandle = {
  mode?: 'degraded-new-pty-fallback'
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

export function unlinkOwnedDaemonPidFile(
  pidPath: string,
  expectedPid: number,
  expectedLaunchNonce: string
): boolean {
  return claimAndUnlinkOwnedFile(pidPath, (content) => {
    try {
      const parsed = JSON.parse(content) as { pid?: unknown; launchNonce?: unknown }
      return parsed.pid === expectedPid && parsed.launchNonce === expectedLaunchNonce
    } catch {
      return false
    }
  })
}

export function unlinkOwnedDaemonTokenFile(tokenPath: string, expectedToken: string): boolean {
  return claimAndUnlinkOwnedFile(tokenPath, (content) => content.trim() === expectedToken)
}

function claimAndUnlinkOwnedFile(
  filePath: string,
  ownsContent: (content: string) => boolean
): boolean {
  const claimedPath = `${filePath}.cleanup-${process.pid}-${randomUUID()}`
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
