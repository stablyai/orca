import { uploadBuffer } from '../ssh/sftp-upload'
import type { SftpFactory, SshRawTransferOptions } from './ssh-filesystem-file-upload'

export async function writeSshFileBase64({
  createSftp,
  rawTransfer,
  filePath,
  contentBase64,
  append,
  mode
}: {
  createSftp?: SftpFactory
  rawTransfer?: SshRawTransferOptions
  filePath: string
  contentBase64: string
  append: boolean
  mode?: number
}): Promise<void> {
  const contents = Buffer.from(contentBase64, 'base64')
  const options = {
    append,
    exclusive: !append,
    ...(mode === undefined ? {} : { mode })
  }
  if (rawTransfer?.writeBuffer) {
    await rawTransfer.writeBuffer(filePath, contents, options)
    return
  }
  if (!createSftp) {
    throw new Error('remote_binary_upload_unavailable')
  }
  const sftp = await createSftp()
  try {
    await uploadBuffer(sftp, contents, filePath, options)
  } finally {
    sftp.end()
  }
}
