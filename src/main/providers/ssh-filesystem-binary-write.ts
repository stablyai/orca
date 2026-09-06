import { uploadBuffer } from '../ssh/sftp-upload'
import type { SftpFactory } from './ssh-filesystem-download'
import type { SshRawTransferOptions } from './ssh-filesystem-file-upload'

export async function writeSshFileBase64Chunk(
  createSftp: SftpFactory | undefined,
  rawTransfer: SshRawTransferOptions | undefined,
  filePath: string,
  contentBase64: string,
  append: boolean
): Promise<void> {
  const contents = Buffer.from(contentBase64, 'base64')
  if (rawTransfer?.writeBuffer) {
    await rawTransfer.writeBuffer(filePath, contents, {
      append,
      exclusive: !append
    })
    return
  }
  if (!createSftp) {
    throw new Error('remote_binary_upload_unavailable')
  }
  const sftp = await createSftp()
  try {
    await uploadBuffer(sftp, contents, filePath, {
      append,
      exclusive: !append
    })
  } finally {
    sftp.end()
  }
}
