// Relay-install SFTP writes. Each helper prefers the SshConnection transfer
// method and otherwise drives one SFTP session itself, because deploy and
// native-dependency tests pass partial connection doubles. Both routes share the
// same namespace resolution, abort race, and one-shot session teardown.

import type { SFTPWrapper } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import { writeStringViaSftp } from './sftp-upload'
import { uploadDirectory } from './ssh-relay-deploy-helpers'
import { raceSftpFileTransferWithAbort } from './ssh-file-transfer-abort'
import {
  resolveSftpTransferPathIfMapped,
  type SftpNamespacePathMapping
} from './sftp-namespace-resolution'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import {
  describeSandboxedSftpFailure,
  isSandboxedSftpNamespaceError,
  latchLateSftpSessionErrors
} from './sftp-stream-late-error'

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
  await withSandboxedSftpDiagnosis(shellRemoteDir, () =>
    uploadRelayDirectoryTransfer(conn, localRelayDir, shellRemoteDir, hostPlatform, options)
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
  await withSandboxedSftpDiagnosis(shellRemotePath, () =>
    writeRelayFileTransfer(conn, hostPlatform, shellRemotePath, contents, options)
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

/**
 * A jump host whose SFTP subsystem is chrooted answers a home path with
 * SSH_FX_NO_SUCH_FILE even though the shell channel resolves it (#15479). SFTP is the
 * only install route on the bundled-ssh2 transport, so say what the host did rather
 * than surfacing a bare "file does not exist".
 */
async function withSandboxedSftpDiagnosis<T>(
  remotePath: string,
  transfer: () => Promise<T>
): Promise<T> {
  try {
    return await transfer()
  } catch (error) {
    if (isSandboxedSftpNamespaceError(error)) {
      throw describeSandboxedSftpFailure(error, remotePath)
    }
    throw error
  }
}
