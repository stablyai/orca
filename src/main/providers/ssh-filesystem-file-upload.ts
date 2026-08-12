import type { SFTPWrapper } from 'ssh2'
import { uploadBuffer, uploadFile as uploadFileViaSftp } from '../ssh/sftp-upload'
import type { FileUploadSession } from './types'

export type SftpFactory = () => Promise<SFTPWrapper>

export type SshRawTransferOptions = {
  downloadFile?: (sourcePath: string, destinationPath: string) => Promise<void>
  openFileUploadSession?: () => Promise<FileUploadSession>
  writeBuffer?: (
    remotePath: string,
    contents: Buffer,
    options: { append: boolean; exclusive: boolean; mode?: number }
  ) => Promise<void>
}

export async function openSshFileUploadSession(
  createSftp?: SftpFactory,
  rawTransfer?: SshRawTransferOptions
): Promise<FileUploadSession> {
  if (rawTransfer?.openFileUploadSession) {
    return rawTransfer.openFileUploadSession()
  }
  if (!createSftp) {
    throw new Error('Remote file upload is unavailable. Reconnect the SSH target and retry.')
  }
  const sftp = await createSftp()
  return {
    // Why: one session covers the whole import so normal SSH keeps its prior
    // channel count even when a directory contains many files.
    uploadFile: (sourcePath, destinationPath, options) =>
      uploadFileViaSftp(sftp, sourcePath, destinationPath, options),
    close: () => sftp.end()
  }
}

export async function writeSshBase64File(
  createSftp: SftpFactory | undefined,
  rawTransfer: SshRawTransferOptions | undefined,
  filePath: string,
  contentBase64: string,
  options: { append: boolean; mode?: number }
): Promise<void> {
  const contents = Buffer.from(contentBase64, 'base64')
  const writeOptions = {
    append: options.append,
    exclusive: !options.append,
    ...(options.mode === undefined ? {} : { mode: options.mode })
  }
  if (rawTransfer?.writeBuffer) {
    await rawTransfer.writeBuffer(filePath, contents, writeOptions)
    return
  }
  if (!createSftp) {
    throw new Error('remote_binary_upload_unavailable')
  }
  const sftp = await createSftp()
  try {
    await uploadBuffer(sftp, contents, filePath, writeOptions)
  } finally {
    sftp.end()
  }
}
