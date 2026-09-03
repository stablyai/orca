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

async function guardSftpOperation<T>(
  sftp: SFTPWrapper,
  operation: () => Promise<T>,
  onChannelError: () => void
): Promise<T> {
  let onSftpError!: (error: Error) => void
  let sftpErrorWonRace = false
  const sftpError = new Promise<never>((_resolve, reject) => {
    onSftpError = (error: Error): void => {
      sftpErrorWonRace = true
      reject(error)
    }
    sftp.prependOnceListener('error', onSftpError)
  })
  try {
    // Why: if sftpError wins the race, this keeps running unobserved and may reject later
    // (e.g. once onChannelError() closes the channel) — swallow that so it doesn't surface
    // as an unhandled rejection; the race's winner is what callers see.
    // Called inside try so a synchronous throw from operation() still runs finally's
    // listener removal below.
    const operationResult = operation()
    operationResult.catch(() => {})
    return await Promise.race([operationResult, sftpError])
  } catch (error) {
    // Why: a channel-level error leaves the session unusable for later calls — close it so
    // callers don't keep writing to a dead channel.
    if (sftpErrorWonRace) {
      onChannelError()
    }
    throw error
  } finally {
    sftp.removeListener('error', onSftpError)
  }
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
  return {
    // Why: one session covers the whole import so normal SSH keeps its prior
    // channel count even when a directory contains many files.
    uploadFile: (sourcePath, destinationPath, options) =>
      guardSftpOperation(
        sftp,
        () => uploadFileViaSftp(sftp, sourcePath, destinationPath, options),
        endSftp
      ),
    close: endSftp
  }
}
