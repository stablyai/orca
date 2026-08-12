import type { SFTPWrapper } from 'ssh2'
import { uploadFile as uploadFileViaSftp } from '../ssh/sftp-upload'
import type { FileUploadSession } from './types'

export type SftpFactory = () => Promise<SFTPWrapper>

export type SshRawTransferOptions = {
  downloadFile?: (sourcePath: string, destinationPath: string) => Promise<void>
  openFileUploadSession?: () => Promise<FileUploadSession>
  writeBuffer?: (
    remotePath: string,
    contents: Buffer,
    options: { append: boolean; exclusive: boolean }
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
