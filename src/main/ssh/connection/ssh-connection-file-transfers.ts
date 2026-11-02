import type { SFTPWrapper } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import type { FileUploadSession } from '../../providers/filesystem-provider-contract'
import {
  resolveSftpTransferPathIfMapped,
  type SftpNamespacePathMapping
} from '../sftp-namespace-resolution'
import {
  createLinkedSshFileTransferSignal,
  raceSftpFileTransferWithAbort,
  sftpSessionClosedError
} from '../ssh-file-transfer-abort'
import type { RemoteHostPlatform } from '../ssh-remote-platform'
import {
  downloadFileViaSystemSsh,
  uploadFileViaSystemSsh,
  writeBufferViaSystemSsh
} from '../system-transport/system-ssh-file-binary-transfer'
import {
  uploadDirectoryViaSystemSsh,
  writeFileViaSystemSsh
} from '../system-transport/system-ssh-file-transfer'
import type { SystemSshBuildArgsOptions } from '../system-transport/system-ssh-args'

export type SshRemoteFileOptions = {
  hostPlatform?: RemoteHostPlatform
  // Only uploadDirectory and writeFile honor this, and only on the non-Windows ssh2 branch.
  sftpNamespace?: SftpNamespacePathMapping
}

/** What a transfer reads from its connection; getters so each read sees the live transport. */
export type SshFileTransferHost = {
  target: SshTarget
  usesSystemSshTransport: () => boolean
  systemOperationSignal: () => AbortSignal
  systemSshBuildArgsOptions: () => SystemSshBuildArgsOptions
  sftp: (signal?: AbortSignal) => Promise<SFTPWrapper>
}

export async function uploadSshDirectory(
  host: SshFileTransferHost,
  localDir: string,
  remoteDir: string,
  options?: SshRemoteFileOptions & { signal?: AbortSignal }
): Promise<void> {
  await withLinkedSftpTransfer(host, remoteDir, options, {
    sftp: async (sftp, targetDir, signal, endSession) => {
      const { uploadDirectory } = await import('../sftp-upload')
      await uploadDirectory(sftp, localDir, targetDir, localDir, { signal, endSession })
    },
    system: (signal) =>
      uploadDirectoryViaSystemSsh(host.target, localDir, remoteDir, {
        signal,
        hostPlatform: options?.hostPlatform,
        ...host.systemSshBuildArgsOptions()
      })
  })
}

export async function downloadSshFile(
  host: SshFileTransferHost,
  remotePath: string,
  localPath: string,
  options?: SshRemoteFileOptions
): Promise<void> {
  if (!host.usesSystemSshTransport()) {
    const sftp = await host.sftp()
    try {
      const { fastGetViaSftp } = await import('../../providers/ssh-filesystem-provider-sftp')
      await fastGetViaSftp(sftp, remotePath, localPath)
    } finally {
      sftp.end()
    }
    return
  }
  await downloadFileViaSystemSsh(host.target, remotePath, localPath, {
    signal: host.systemOperationSignal(),
    hostPlatform: options?.hostPlatform,
    ...host.systemSshBuildArgsOptions()
  })
}

export async function createSshFileUploadSession(
  host: SshFileTransferHost,
  options?: SshRemoteFileOptions
): Promise<FileUploadSession> {
  if (!host.usesSystemSshTransport()) {
    const sftp = await host.sftp()
    const { uploadFile } = await import('../sftp-upload')
    return {
      uploadFile: (localPath, remotePath, uploadOptions) =>
        uploadFile(sftp, localPath, remotePath, uploadOptions),
      close: () => sftp.end()
    }
  }
  // Capture config/signal once: disconnect replaces the controller while existing imports belong to their original session.
  const signal = host.systemOperationSignal()
  const buildArgsOptions = host.systemSshBuildArgsOptions()
  return {
    uploadFile: (localPath, remotePath, uploadOptions) =>
      uploadFileViaSystemSsh(host.target, localPath, remotePath, {
        signal,
        hostPlatform: options?.hostPlatform,
        exclusive: uploadOptions?.exclusive,
        ...buildArgsOptions,
        // Read loopback routing live so a dead session route cannot be dialled.
        loopbackRoute: host.systemSshBuildArgsOptions().loopbackRoute
      }),
    close: () => {}
  }
}

export async function writeSshFile(
  host: SshFileTransferHost,
  remotePath: string,
  contents: string,
  options?: SshRemoteFileOptions & { signal?: AbortSignal }
): Promise<void> {
  await withLinkedSftpTransfer(host, remotePath, options, {
    sftp: async (sftp, targetPath) => {
      const { writeStringViaSftp } = await import('../sftp-upload')
      await writeStringViaSftp(sftp, targetPath, contents)
    },
    system: (signal) =>
      writeFileViaSystemSsh(host.target, remotePath, contents, {
        signal,
        hostPlatform: options?.hostPlatform,
        ...host.systemSshBuildArgsOptions()
      })
  })
}

/** Link caller/connection cancellation; ssh2 maps paths and transfers on one SFTP session, closed on abort or completion. */
async function withLinkedSftpTransfer(
  host: SshFileTransferHost,
  remotePath: string,
  options: (SshRemoteFileOptions & { signal?: AbortSignal }) | undefined,
  transfer: {
    sftp: (
      sftp: SFTPWrapper,
      targetPath: string,
      signal: AbortSignal,
      endSession: () => void
    ) => Promise<void>
    system: (signal: AbortSignal) => Promise<void>
  }
): Promise<void> {
  const linkedSignal = createLinkedSshFileTransferSignal(
    [host.systemOperationSignal(), options?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    )
  )
  // Session loss fails the transfer and closes local files; it must not become a caller-cancellation outcome.
  const sessionLoss = new AbortController()
  const transferSignal = createLinkedSshFileTransferSignal([
    linkedSignal.signal,
    sessionLoss.signal
  ])
  try {
    if (host.usesSystemSshTransport()) {
      await transfer.system(linkedSignal.signal)
      return
    }
    const sftp = await host.sftp(linkedSignal.signal)
    const swallowLateSftpError = (): void => {}
    let sftpEndRequested = false
    const endSftp = (): void => {
      if (!sftpEndRequested) {
        sftpEndRequested = true
        sftp.end()
      }
    }
    sftp.on('error', swallowLateSftpError)
    sftp.once('close', () => sftp.removeListener('error', swallowLateSftpError))
    // ssh2 never answers queued/post-loss requests or stream CLOSE; race session loss explicitly.
    let sessionLost: (error: Error) => void = () => {}
    const lostSession = new Promise<never>((_resolve, reject) => {
      sessionLost = reject
    })
    let sftpClosed = false
    const onSessionClose = (): void => {
      sftpClosed = true
      if (!sftpEndRequested) {
        const error = sftpSessionClosedError()
        sessionLost(error)
        sessionLoss.abort(error)
      }
    }
    sftp.once('close', onSessionClose)
    try {
      // Resolve paths on the transferring session; a later session cannot authorize this namespace.
      const run = (async (): Promise<void> => {
        const targetPath = await resolveSftpTransferPathIfMapped(sftp, remotePath, options)
        transferSignal.signal.throwIfAborted()
        await transfer.sftp(sftp, targetPath, transferSignal.signal, endSftp)
      })()
      await Promise.race([
        raceSftpFileTransferWithAbort(run, linkedSignal.signal, (onClose) => {
          if (sftpClosed) {
            onClose()
          } else {
            sftp.once('close', onClose)
          }
          endSftp()
          return () => sftp.removeListener('close', onClose)
        }),
        lostSession
      ])
    } finally {
      sftp.removeListener('close', onSessionClose)
      endSftp()
    }
  } finally {
    transferSignal.dispose()
    linkedSignal.dispose()
  }
}

export async function writeSshBuffer(
  host: SshFileTransferHost,
  remotePath: string,
  contents: Buffer,
  options?: SshRemoteFileOptions & { append?: boolean; exclusive?: boolean }
): Promise<void> {
  if (!host.usesSystemSshTransport()) {
    const sftp = await host.sftp()
    try {
      const { uploadBuffer } = await import('../sftp-upload')
      await uploadBuffer(sftp, contents, remotePath, options)
    } finally {
      sftp.end()
    }
    return
  }
  await writeBufferViaSystemSsh(host.target, remotePath, contents, {
    signal: host.systemOperationSignal(),
    hostPlatform: options?.hostPlatform,
    append: options?.append,
    exclusive: options?.exclusive,
    ...host.systemSshBuildArgsOptions()
  })
}
