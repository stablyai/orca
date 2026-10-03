import type { Readable, Writable } from 'node:stream'

export type SftpUploadObservers = {
  onRemoteCreated?: () => void
  onBytesTransferred?: (bytes: number) => void
}

/** Reports the remote open (the upload's own create) and each chunk read toward the upload. */
export function observeSftpUpload(
  writeStream: Writable,
  readStream: Readable,
  observers: SftpUploadObservers | undefined
): void {
  const onRemoteCreated = observers?.onRemoteCreated
  if (onRemoteCreated) {
    writeStream.once('open', () => onRemoteCreated())
  }
  const onBytesTransferred = observers?.onBytesTransferred
  if (onBytesTransferred) {
    // Why: pipe backpressure keeps bytes read within one SFTP window of bytes written.
    readStream.on('data', (chunk: Buffer | string) => onBytesTransferred(chunk.length))
  }
}
