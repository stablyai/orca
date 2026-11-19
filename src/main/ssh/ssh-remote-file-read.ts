import type { Stats, SFTPWrapper } from 'ssh2'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeFileReadChunkResult } from '../../shared/file-content/runtime-file-read'
import { downloadFileViaSystemSsh } from './system-transport/file-transfer/system-ssh-file-binary-transfer'
import type {
  SshFileTransferHost,
  SshRemoteFileOptions
} from './file-transfer/ssh-connection-file-transfers'

export type SshRemoteFileReadChunkResult = RuntimeFileReadChunkResult & {
  size: number
  mtime: number
}

/** Reads a bounded remote range using SFTP or the existing system-SSH transfer path. */
export async function readSshFileChunk(
  host: SshFileTransferHost,
  remotePath: string,
  offset: number,
  length: number,
  options?: SshRemoteFileOptions
): Promise<SshRemoteFileReadChunkResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Remote file offset is invalid')
  }
  if (!Number.isSafeInteger(length) || length <= 0 || length > 512 * 1024) {
    throw new Error('Remote file chunk length is invalid')
  }

  if (host.usesSystemSshTransport()) {
    return readSystemSshFileChunk(host, remotePath, offset, length, options)
  }

  const sftp = await host.sftp()
  try {
    const attributes = await sftpStat(sftp, remotePath)
    if (attributes.isDirectory()) {
      throw new Error('Remote path is a directory')
    }
    return await readSftpFileChunk(sftp, remotePath, attributes, offset, length)
  } finally {
    sftp.end()
  }
}

async function readSftpFileChunk(
  sftp: SFTPWrapper,
  remotePath: string,
  attributes: Stats,
  offset: number,
  length: number
): Promise<SshRemoteFileReadChunkResult> {
  const handle = await sftpOpen(sftp, remotePath)
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await sftpRead(sftp, handle, buffer, offset)
    return {
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: offset + bytesRead >= attributes.size,
      size: attributes.size,
      mtime: attributes.mtime * 1000
    }
  } finally {
    await sftpClose(sftp, handle)
  }
}

async function readSystemSshFileChunk(
  host: SshFileTransferHost,
  remotePath: string,
  offset: number,
  length: number,
  options?: SshRemoteFileOptions
): Promise<SshRemoteFileReadChunkResult> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-ssh-read-'))
  const localPath = join(directory, 'remote-file')
  try {
    await downloadFileViaSystemSsh(host.target, remotePath, localPath, {
      signal: host.systemOperationSignal(),
      hostPlatform: options?.hostPlatform,
      ...host.systemSshBuildArgsOptions()
    })
    const metadata = await stat(localPath)
    const handle = await open(localPath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return {
        contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
        bytesRead,
        eof: offset + bytesRead >= metadata.size,
        size: metadata.size,
        mtime: metadata.mtimeMs
      }
    } finally {
      await handle.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, attributes) => {
      if (error || !attributes) {
        reject(error ?? new Error('Remote file metadata is unavailable'))
      } else {
        resolve(attributes)
      }
    })
  })
}

function sftpOpen(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'r', (error, handle) => {
      if (error || !handle) {
        reject(error ?? new Error('Remote file could not be opened'))
      } else {
        resolve(handle)
      }
    })
  })
}

function sftpRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  position: number
): Promise<{ bytesRead: number }> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, 0, buffer.length, position, (error, bytesRead) => {
      if (error) {
        reject(error)
      } else {
        resolve({ bytesRead })
      }
    })
  })
}

function sftpClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolve()))
  })
}
