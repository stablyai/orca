// OpenSSH maps ENOSPC/EDQUOT to generic SFTP failure; host free space supplies the diagnosis.

import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteInstallTransport } from './remote-install-transport'
import { dfAvailableKb, formatKb } from '../host-state/remote-filesystem-space'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'

const DIAGNOSIS_TIMEOUT_MS = 15_000
const SSH_FX_FAILURE = 4
// Partial writes may consume room; only an effectively full filesystem proves exhaustion.
const EXHAUSTED_KB = 1024

export class RemoteInstallOutOfSpaceError extends Error {
  constructor(
    readonly remotePath: string,
    readonly availableKb: number,
    readonly neededKb: number,
    cause: unknown
  ) {
    super(
      `The host is out of disk space: the filesystem holding ${remotePath} has ` +
        `${formatKb(availableKb)} free, and Orca needs about ${formatKb(neededKb)} to install ` +
        'its server there. Free up space on the host (or raise your disk quota), then connect again.',
      { cause }
    )
    this.name = 'RemoteInstallOutOfSpaceError'
  }
}

export function remoteFreeSpaceProbeCommand(remotePath: string): string {
  return (
    `p=${quotePosixShell(remotePath)}; ` +
    `while [ ! -d "$p" ] && [ "$p" != / ] && [ "$p" != . ]; do p=$(dirname "$p"); done; ` +
    `df -Pk "$p" 2>/dev/null | tail -n 1`
  )
}

/** Match uploadDirectory: follow the root, skip interior symlinks. */
export async function localTreeBytes(path: string, root = true): Promise<number> {
  const info = await (root ? stat(path) : lstat(path))
  if (info.isSymbolicLink()) {
    return 0
  }
  if (!info.isDirectory()) {
    return info.size
  }
  let total = 0
  for (const entry of await readdir(path)) {
    total += await localTreeBytes(join(path, entry), false)
  }
  return total
}

/** Diagnose generic SFTP failure only on proven exhaustion; preserve lost or aborted transfers. */
export async function explainRemoteInstallWriteFailure(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  remotePath: string,
  neededBytes: () => Promise<number>,
  error: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  if (
    isWindowsRemoteHost(host) ||
    signal?.aborted ||
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== SSH_FX_FAILURE ||
    isUnconfirmedSshCommandTermination(error)
  ) {
    return error
  }
  try {
    const [line, needed] = await Promise.all([
      execHostCommand(conn, host, remoteFreeSpaceProbeCommand(remotePath), {
        signal,
        timeoutMs: DIAGNOSIS_TIMEOUT_MS
      }),
      neededBytes()
    ])
    const availableKb = dfAvailableKb(line.trim().split(/\r?\n/u).at(-1))
    const neededKb = Math.ceil(needed / 1024)
    return availableKb !== null && availableKb < Math.min(neededKb, EXHAUSTED_KB)
      ? new RemoteInstallOutOfSpaceError(remotePath, availableKb, neededKb, error)
      : error
  } catch {
    return error
  }
}
