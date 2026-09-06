import { open, stat } from 'node:fs/promises'

export const RELAY_FILE_CHUNK_MAX_BYTES = 512 * 1024

export type RelayFileChunkResult = {
  contentBase64: string
  bytesRead: number
  eof: boolean
}

export async function readRelayFileChunk(args: {
  filePath: string
  offset: number
  length: number
}): Promise<RelayFileChunkResult> {
  if (
    !Number.isSafeInteger(args.offset) ||
    args.offset < 0 ||
    !Number.isSafeInteger(args.length) ||
    args.length < 1 ||
    args.length > RELAY_FILE_CHUNK_MAX_BYTES
  ) {
    throw new Error('invalid_file_chunk_range')
  }
  const fileStats = await stat(args.filePath)
  if (fileStats.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  const available = Math.max(0, fileStats.size - args.offset)
  const buffer = Buffer.alloc(Math.min(args.length, available))
  const handle = await open(args.filePath, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, args.offset)
    return {
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: args.offset + bytesRead >= fileStats.size
    }
  } finally {
    await handle.close()
  }
}
