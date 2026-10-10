// Relay-install SFTP writes. Each helper prefers the SshConnection transfer
// method and otherwise drives one SFTP session itself, because deploy and
// native-dependency tests pass partial connection doubles. Both routes share the
// same namespace resolution, abort race, and one-shot session teardown. When the
// host definitively refuses SFTP, POSIX hosts fall back to exec-channel stdin.

import type { SFTPWrapper } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import { writeStringViaSftp } from './sftp-upload'
import { uploadDirectory } from './ssh-relay-deploy-helpers'
import { raceSftpFileTransferWithAbort } from './ssh-file-transfer-abort'
import {
  resolveSftpTransferPathIfMapped,
  type SftpNamespacePathMapping
} from './sftp-namespace-resolution'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  uploadDirectoryViaExecStdin,
  writeStringViaExecStdin
} from './ssh-exec-stdin-file-transfer'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  describeSandboxedSftpFailure,
  isSandboxedSftpNamespaceError,
  latchLateSftpSessionErrors
} from './sftp-stream-late-error'
import { isSftpHandshakeCorruption } from './sftp-handshake-corruption'

export type RelayTransferOptions = {
  signal?: AbortSignal
  sftpNamespace?: SftpNamespacePathMapping
}

export async function uploadRelayDirectory(
  conn: SshConnection,
  localRelayDir: string,
  shellRemoteDir: string,
  hostPlatform: RemoteHostPlatform,
  options?: RelayTransferOptions
): Promise<void> {
  await transferWithExecStdinFallback(
    conn,
    hostPlatform,
    shellRemoteDir,
    options?.signal,
    () => uploadRelayDirectoryTransfer(conn, localRelayDir, shellRemoteDir, hostPlatform, options),
    () =>
      uploadDirectoryViaExecStdin(conn, localRelayDir, shellRemoteDir, hostPlatform, {
        signal: options?.signal
      })
  )
}

async function uploadRelayDirectoryTransfer(
  conn: SshConnection,
  localRelayDir: string,
  shellRemoteDir: string,
  hostPlatform: RemoteHostPlatform,
  options?: RelayTransferOptions
): Promise<void> {
  if (typeof conn.uploadDirectory === 'function') {
    await conn.uploadDirectory(localRelayDir, shellRemoteDir, {
      hostPlatform,
      signal: options?.signal,
      sftpNamespace: options?.sftpNamespace
    })
    return
  }
  await runSftpFallbackTransfer(conn, options, async (sftp) => {
    const targetDir = await resolveSftpTransferPathIfMapped(sftp, shellRemoteDir, {
      hostPlatform,
      sftpNamespace: options?.sftpNamespace
    })
    options?.signal?.throwIfAborted()
    await uploadDirectory(sftp, localRelayDir, targetDir, localRelayDir, {
      signal: options?.signal
    })
  })
}

export async function writeRelayFile(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  shellRemotePath: string,
  contents: string,
  options?: RelayTransferOptions
): Promise<void> {
  await transferWithExecStdinFallback(
    conn,
    hostPlatform,
    shellRemotePath,
    options?.signal,
    () => writeRelayFileTransfer(conn, hostPlatform, shellRemotePath, contents, options),
    () => writeStringViaExecStdin(conn, shellRemotePath, contents, { signal: options?.signal })
  )
}

async function writeRelayFileTransfer(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  shellRemotePath: string,
  contents: string,
  options?: RelayTransferOptions
): Promise<void> {
  if (typeof conn.writeFile === 'function') {
    await conn.writeFile(shellRemotePath, contents, {
      hostPlatform,
      signal: options?.signal,
      sftpNamespace: options?.sftpNamespace
    })
    return
  }
  await runSftpFallbackTransfer(conn, options, async (sftp) => {
    const targetPath = await resolveSftpTransferPathIfMapped(sftp, shellRemotePath, {
      hostPlatform,
      sftpNamespace: options?.sftpNamespace
    })
    options?.signal?.throwIfAborted()
    await writeStringViaSftp(sftp, targetPath, contents)
  })
}

async function runSftpFallbackTransfer(
  conn: SshConnection,
  options: RelayTransferOptions | undefined,
  transfer: (sftp: SFTPWrapper) => Promise<void>
): Promise<void> {
  const sftp = await conn.sftp(options?.signal)
  let sftpEndRequested = false
  const endSftp = (): void => {
    if (!sftpEndRequested) {
      sftpEndRequested = true
      sftp.end()
    }
  }
  latchLateSftpSessionErrors(sftp)
  try {
    await raceSftpFileTransferWithAbort(
      transfer(sftp),
      options?.signal ?? new AbortController().signal,
      (onClose) => {
        sftp.once('close', onClose)
        endSftp()
        return () => sftp.removeListener('close', onClose)
      }
    )
  } finally {
    endSftp()
  }
}

export type SftpExecFallbackReason = 'sftp-unavailable' | 'sftp-sandboxed'

/**
 * Only the host's own answer about SFTP selects exec stdin. A lost transport, a timeout or an
 * abort is unverifiable and must surface, never retry down another path.
 */
export function classifySftpFailureForExecFallback(error: unknown): SftpExecFallbackReason | null {
  if (!(error instanceof Error) || isUnconfirmedSshCommandTermination(error)) {
    return null
  }
  // ssh2's words when sshd refuses the subsystem (no `Subsystem sftp`, e.g. #12868 Synology).
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
  // A shell-created path the SFTP view cannot see: a chrooted subsystem (#15479).
  if (isSandboxedSftpNamespaceError(error)) {
    return 'sftp-sandboxed'
  }
  return null
}

/** Exec stdin needs a POSIX shell; the system-SSH transport never used SFTP for these writes. */
function canFallBackToExecStdin(conn: SshConnection, hostPlatform: RemoteHostPlatform): boolean {
  return !isWindowsRemoteHost(hostPlatform) && conn.usesSystemSshTransport?.() !== true
}

// Why per connect generation: a refused subsystem is a host verdict, but a reconnect may reach
// a different host behind the same alias.
const sftpUnavailableGeneration = new WeakMap<SshConnection, number>()

function connectGeneration(conn: SshConnection): number {
  return conn.getConnectGeneration?.() ?? 0
}

async function transferWithExecStdinFallback(
  conn: SshConnection,
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
      `[ssh-relay] SFTP ${reason === 'sftp-unavailable' ? 'is unavailable' : 'cannot see the install path'} (${error instanceof Error ? error.message : String(error)}); streaming ${remotePath} over exec stdin`
    )
  }
  await execStdinTransfer()
}
