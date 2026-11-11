import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeTransportMetadata } from '../../../../shared/runtime-bootstrap'
import {
  resolveDaemonUnixSocketPath,
  shortDaemonSocketDir
} from '../../../daemon/endpoint/publication/daemon-socket-endpoint-path'

// MUST match createRuntimeTransportMetadata's o-${pid}-${suffix}.sock naming; unit tests enforce parity.
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

/** Dirs that can hold this userData's runtime sockets: itself and its relocated short dir. */
export function runtimeSocketDirs(
  userDataPath: string,
  uid: number | undefined = process.getuid?.()
): string[] {
  return uid === undefined
    ? [userDataPath]
    : [userDataPath, shortDaemonSocketDir(userDataPath, uid)]
}

export function sweepOrphanedRuntimeSockets(socketDir: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(socketDir)
  } catch {
    // First launch may have no userData to sweep.
    return
  }
  for (const entry of entries) {
    const match = RUNTIME_SOCKET_NAME_REGEX.exec(entry)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isFinite(pid)) {
      continue
    }
    // Never sweep our own socket before binding it.
    if (pid === ownPid) {
      continue
    }
    try {
      // Signal zero only probes liveness: ESRCH is dead; EPERM is a foreign owner and must remain.
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(socketDir, entry), { force: true })
        } catch {
          // Sweep best-effort; later startup or reboot handles unlink failures.
        }
      }
    }
  }
}

export function createRuntimeTransportMetadata(
  userDataPath: string,
  pid: number,
  platform: NodeJS.Platform,
  runtimeId = 'runtime'
): RuntimeTransportMetadata {
  const endpointSuffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      // Named pipes lack Unix chmod; use per-runtime suffixes to avoid stable, guessable endpoints.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    // Long userData paths overflow sun_path (EINVAL); relocate like the daemon socket.
    endpoint: resolveDaemonUnixSocketPath(userDataPath, `o-${pid}-${endpointSuffix}.sock`, platform)
  }
}
