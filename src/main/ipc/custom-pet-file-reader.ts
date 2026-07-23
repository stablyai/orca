import { open } from 'node:fs/promises'
import { MAX_CUSTOM_PET_FILE_BYTES } from '../../shared/custom-pet-media-limits'

const MAX_CUSTOM_PET_READ_CALLS = 1_024

export class CustomPetFileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Custom pet file exceeds the ${maxBytes} byte limit.`)
    this.name = 'CustomPetFileTooLargeError'
  }
}

export async function readCustomPetFile(
  filePath: string,
  maxBytes = MAX_CUSTOM_PET_FILE_BYTES
): Promise<ArrayBuffer> {
  const file = await open(filePath, 'r')
  try {
    const beforeRead = await file.stat()
    if (!beforeRead.isFile()) {
      throw new Error('Custom pet path is not a file.')
    }
    if (
      !Number.isSafeInteger(beforeRead.size) ||
      beforeRead.size < 0 ||
      beforeRead.size > maxBytes
    ) {
      throw new CustomPetFileTooLargeError(maxBytes)
    }

    const bytes = new ArrayBuffer(beforeRead.size)
    const target = Buffer.from(bytes)
    let offset = 0
    let readCalls = 0
    while (offset < target.byteLength && readCalls < MAX_CUSTOM_PET_READ_CALLS) {
      const result = await file.read(target, offset, target.byteLength - offset, offset)
      readCalls += 1
      if (result.bytesRead === 0) {
        break
      }
      offset += result.bytesRead
    }

    const sentinel = Buffer.allocUnsafe(1)
    const extra = await file.read(sentinel, 0, 1, offset)
    const afterRead = await file.stat()
    if (
      offset !== beforeRead.size ||
      extra.bytesRead !== 0 ||
      afterRead.size !== beforeRead.size ||
      bytes.byteLength > maxBytes
    ) {
      throw new Error('Custom pet file changed while it was being read.')
    }
    return bytes
  } finally {
    await file.close()
  }
}
