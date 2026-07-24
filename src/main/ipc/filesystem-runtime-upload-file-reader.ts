type RuntimeUploadFileHandle = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
}

export async function readStableRuntimeUploadFile(
  fileHandle: RuntimeUploadFileHandle,
  expectedBytes: number,
  displayPath: string
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(expectedBytes)
  let offset = 0
  while (offset < expectedBytes) {
    const { bytesRead } = await fileHandle.read(buffer, offset, expectedBytes - offset, offset)
    if (bytesRead === 0) {
      throw fileChangedError(displayPath)
    }
    offset += bytesRead
  }
  const probe = Buffer.allocUnsafe(1)
  if ((await fileHandle.read(probe, 0, 1, offset)).bytesRead !== 0) {
    throw fileChangedError(displayPath)
  }
  return buffer
}

function fileChangedError(displayPath: string): Error {
  return new Error(`File changed during upload staging: '${displayPath}'`)
}
