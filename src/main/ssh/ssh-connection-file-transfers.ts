import type { SFTPWrapper } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import type { FileUploadSession } from '../providers/types'
import {
  resolveSftpTransferPathIfMapped,
  type SftpNamespacePathMapping
} from './sftp-namespace-resolution'
import {
  createLinkedSshFileTransferSignal,
  raceSftpFileTransferWithAbort
} from './ssh-file-transfer-abort'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import {
  downloadFileViaSystemSsh,
  uploadDirectoryViaSystemSsh,
  uploadFileViaSystemSsh,
  writeBufferViaSystemSsh,
  writeFileViaSystemSsh,
  type SystemSshBuildArgsOptions
} from './ssh-system-fallback'

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
  // Why: relay-deploy timeout and connection teardown are independent owners; either must stop a transfer that could outlive its lock.
  const linkedSignal = createLinkedSshFileTransferSignal(
    [host.systemOperationSignal(), options?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    )
  )
  try {
    if (!host.usesSystemSshTransport()) {
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
      try {
        // Why: resolve on the same session that transfers — a later session is not authoritative for this one's namespace.
        const transfer = (async (): Promise<void> => {
          const targetDir = await resolveSftpTransferPathIfMapped(sftp, remoteDir, options)
          linkedSignal.signal.throwIfAborted()
          const { uploadDirectory } = await import('./ssh-relay-deploy-helpers')
          await uploadDirectory(sftp, localDir, targetDir, localDir, {
            signal: linkedSignal.signal
          })
        })()
        await raceSftpFileTransferWithAbort(transfer, linkedSignal.signal, (onClose) => {
          sftp.once('close', onClose)
          endSftp()
          return () => sftp.removeListener('close', onClose)
        })
      } finally {
        endSftp()
      }
      return
    }
    await uploadDirectoryViaSystemSsh(host.target, localDir, remoteDir, {
      signal: linkedSignal.signal,
      hostPlatform: options?.hostPlatform,
      ...host.systemSshBuildArgsOptions()
    })
  } finally {
    linkedSignal.dispose()
  }
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
      const { fastGetViaSftp } = await import('../providers/ssh-filesystem-provider-sftp')
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
    const { uploadFile } = await import('./sftp-upload')
    return {
      uploadFile: (localPath, remotePath, uploadOptions) =>
        uploadFile(sftp, localPath, remotePath, uploadOptions),
      close: () => sftp.end()
    }
  }
  // Why: disconnect replaces the connection controller, so an existing import session must stay bound to the signal and SSH config it opened with.
  const signal = host.systemOperationSignal()
  const buildArgsOptions = host.systemSshBuildArgsOptions()
  return {
    uploadFile: (localPath, remotePath, uploadOptions) =>
      uploadFileViaSystemSsh(host.target, localPath, remotePath, {
        signal,
        hostPlatform: options?.hostPlatform,
        exclusive: uploadOptions?.exclusive,
        ...buildArgsOptions
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
  // Keep package/version writes under the same dual cancellation contract as uploads.
  const linkedSignal = createLinkedSshFileTransferSignal(
    [host.systemOperationSignal(), options?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    )
  )
  try {
    if (!host.usesSystemSshTransport()) {
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
      try {
        // Why: resolve on the same session that writes — a later session is not authoritative for this one's namespace.
        const write = (async (): Promise<void> => {
          const targetPath = await resolveSftpTransferPathIfMapped(sftp, remotePath, options)
          linkedSignal.signal.throwIfAborted()
          const { writeStringViaSftp } = await import('./sftp-upload')
          await writeStringViaSftp(sftp, targetPath, contents)
        })()
        await raceSftpFileTransferWithAbort(write, linkedSignal.signal, (onClose) => {
          sftp.once('close', onClose)
          endSftp()
          return () => sftp.removeListener('close', onClose)
        })
      } finally {
        endSftp()
      }
      return
    }
    await writeFileViaSystemSsh(host.target, remotePath, contents, {
      signal: linkedSignal.signal,
      hostPlatform: options?.hostPlatform,
      ...host.systemSshBuildArgsOptions()
    })
  } finally {
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
      const { uploadBuffer } = await import('./sftp-upload')
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
