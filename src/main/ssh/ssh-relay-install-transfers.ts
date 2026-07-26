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
    await uploadDirectory(sftp, localRelayDir, targetDir)
  })
}

export async function writeRelayFile(
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
  const swallowLateSftpError = (): void => {}
  let sftpEndRequested = false
  const endSftp = (): void => {
    if (!sftpEndRequested) {
      sftpEndRequested = true
      sftp.end()
    }
  }
  // A late session 'error' after settle would otherwise be unhandled and crash main.
  sftp.on('error', swallowLateSftpError)
  sftp.once('close', () => sftp.removeListener('error', swallowLateSftpError))
  try {
    await raceSftpFileTransferWithAbort(
      transfer(sftp),
      options?.signal ?? new AbortController().signal,
      (onClose) => {
        sftp.once('close', onClose)
        endSftp()
      }
    )
  } finally {
    endSftp()
  }
}
