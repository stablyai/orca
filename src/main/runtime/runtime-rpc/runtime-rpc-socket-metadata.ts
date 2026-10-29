import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeTransportMetadata } from '../../../shared/runtime-bootstrap'

// MUST match createRuntimeTransportMetadata's o-${pid}-${suffix}.sock naming; unit tests enforce parity.
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

export function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
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
          rmSync(join(userDataPath, entry), { force: true })
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
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
