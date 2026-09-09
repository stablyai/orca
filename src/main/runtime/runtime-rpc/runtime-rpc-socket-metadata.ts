import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeTransportMetadata } from '../../../shared/runtime-bootstrap'

/** Why: MUST stay in lockstep with createRuntimeTransportMetadata()'s `o-${pid}-${suffix}.sock` shape (unit-test enforced). */
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

export function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
  } catch {
    // Why: first-launch userData may not exist yet; nothing to sweep.
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
    // Why: never delete our own socket — a bug here would rmSync one we're about to bind.
    if (pid === ownPid) {
      continue
    }
    try {
      // Why: signal 0 is the POSIX liveness probe (sends nothing); ESRCH = dead pid, EPERM = foreign owner (left alone).
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(userDataPath, entry), { force: true })
        } catch {
          // Why: best-effort sweep; a later start() or OS reboot cleans any socket we can't unlink.
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
      // Why: named pipes lack the chmod hardening of Unix sockets; a per-runtime suffix avoids a stable, guessable endpoint name.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
