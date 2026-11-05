import type { RemoteInstallTransport } from './remote-install-transport'
import type { SftpNamespacePathMapping } from '../../ssh/sftp-namespace-resolution'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  uploadDirectoryViaExecStdin,
  writeStringViaExecStdin
} from '../../ssh/ssh-exec-stdin-file-transfer'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import {
  describeSandboxedSftpFailure,
  isSandboxedSftpNamespaceError
} from '../../ssh/sftp-stream-late-error'
import { isSftpHandshakeCorruption } from '../../ssh/sftp-handshake-corruption'
import { explainRemoteInstallWriteFailure, localTreeBytes } from './remote-install-out-of-space'

type RemoteInstallTransferOptions = {
  signal?: AbortSignal
  sftpNamespace?: SftpNamespacePathMapping
}

export async function uploadRemoteInstallDirectory(
  conn: RemoteInstallTransport,
  localDir: string,
  shellRemoteDir: string,
  hostPlatform: RemoteHostPlatform,
  options?: RemoteInstallTransferOptions
): Promise<void> {
  await transferWithExecStdinFallback(
    conn,
    hostPlatform,
    shellRemoteDir,
    options?.signal,
    () => localTreeBytes(localDir),
    () =>
      conn.uploadDirectory(localDir, shellRemoteDir, {
        hostPlatform,
        signal: options?.signal,
        sftpNamespace: options?.sftpNamespace
      }),
    () =>
      uploadDirectoryViaExecStdin(conn, localDir, shellRemoteDir, hostPlatform, {
        signal: options?.signal
      })
  )
}

export async function writeRemoteInstallFile(
  conn: RemoteInstallTransport,
  hostPlatform: RemoteHostPlatform,
  shellRemotePath: string,
  contents: string,
  options?: RemoteInstallTransferOptions
): Promise<void> {
  await transferWithExecStdinFallback(
    conn,
    hostPlatform,
    shellRemotePath,
    options?.signal,
    async () => Buffer.byteLength(contents),
    () =>
      conn.writeFile(shellRemotePath, contents, {
        hostPlatform,
        signal: options?.signal,
        sftpNamespace: options?.sftpNamespace
      }),
    () => writeStringViaExecStdin(conn, shellRemotePath, contents, { signal: options?.signal })
  )
}

type SftpExecFallbackReason = 'sftp-unavailable' | 'sftp-sandboxed'

/** Retry via exec stdin only on definitive SFTP refusal; uncertain transfers must surface. */
export function classifySftpFailureForExecFallback(error: unknown): SftpExecFallbackReason | null {
  if (!(error instanceof Error) || isUnconfirmedSshCommandTermination(error)) {
    return null
  }
  // ssh2 reports this when sshd refuses the subsystem (e.g. Synology #12868).
  if (error.message === 'Unable to start subsystem: sftp') {
    return 'sftp-unavailable'
  }
  // sshd accepted the subsystem but its sftp-server exited before the handshake.
  if (/^Received exit code \d+ while establishing SFTP session$/.test(error.message)) {
    return 'sftp-unavailable'
  }
  // Startup-file output corrupted the handshake; it recurs on every subsystem start.
  if (isSftpHandshakeCorruption(error)) {
    return 'sftp-unavailable'
  }
  // Chrooted SFTP cannot see paths created through the shell (#15479).
  if (isSandboxedSftpNamespaceError(error)) {
    return 'sftp-sandboxed'
  }
  return null
}

function canFallBackToExecStdin(
  conn: RemoteInstallTransport,
  hostPlatform: RemoteHostPlatform
): boolean {
  return !isWindowsRemoteHost(hostPlatform) && conn.usesSystemSshTransport?.() !== true
}

// Reconnect may reach a different host behind the same alias; scope cached refusal by generation.
const sftpUnavailableGeneration = new WeakMap<RemoteInstallTransport, number>()

function connectGeneration(conn: RemoteInstallTransport): number {
  return conn.getConnectGeneration?.() ?? 0
}

async function transferWithExecStdinFallback(
  conn: RemoteInstallTransport,
  hostPlatform: RemoteHostPlatform,
  remotePath: string,
  signal: AbortSignal | undefined,
  neededBytes: () => Promise<number>,
  sftpTransfer: () => Promise<void>,
  execStdinTransfer: () => Promise<void>
): Promise<void> {
  try {
    await transferOnce(conn, hostPlatform, remotePath, signal, sftpTransfer, execStdinTransfer)
  } catch (error) {
    throw await explainRemoteInstallWriteFailure(
      conn,
      hostPlatform,
      remotePath,
      neededBytes,
      error,
      signal
    )
  }
}

async function transferOnce(
  conn: RemoteInstallTransport,
  hostPlatform: RemoteHostPlatform,
  remotePath: string,
  signal: AbortSignal | undefined,
  sftpTransfer: () => Promise<void>,
  execStdinTransfer: () => Promise<void>
): Promise<void> {
  const fallbackAllowed = canFallBackToExecStdin(conn, hostPlatform)
  if (fallbackAllowed && sftpUnavailableGeneration.get(conn) === connectGeneration(conn)) {
    await execStdinTransfer()
    return
  }
  try {
    await sftpTransfer()
    return
  } catch (error) {
    const reason = fallbackAllowed ? classifySftpFailureForExecFallback(error) : null
    if (!reason) {
      if (isSandboxedSftpNamespaceError(error)) {
        throw describeSandboxedSftpFailure(error, remotePath)
      }
      throw error
    }
    signal?.throwIfAborted()
    if (reason === 'sftp-unavailable') {
      sftpUnavailableGeneration.set(conn, connectGeneration(conn))
    }
    console.warn(
      `[ssh] SFTP ${reason === 'sftp-unavailable' ? 'is unavailable' : 'cannot see the install path'} (${error instanceof Error ? error.message : String(error)}); streaming ${remotePath} over exec stdin`
    )
  }
  await execStdinTransfer()
}
