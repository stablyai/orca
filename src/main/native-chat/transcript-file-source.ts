import type { IFilesystemProvider } from '../providers/types'

const MAX_TRANSCRIPT_SOURCE_READ_BYTES = 64 * 1024

export type TranscriptFileVersion = {
  identity: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export type TranscriptFileReader = {
  read(offset: number, length: number): Promise<Buffer>
  close(): Promise<void>
}

export type TranscriptFileSource = {
  supportsNativeWatch: boolean
  stat(filePath: string): Promise<TranscriptFileVersion>
  open(filePath: string): Promise<TranscriptFileReader>
}

export function createProviderTranscriptFileSource(
  authorize: () => IFilesystemProvider | Promise<IFilesystemProvider>
): TranscriptFileSource {
  return {
    supportsNativeWatch: false,
    async stat(filePath) {
      const value = await (await authorize()).stat(filePath)
      if (
        value.type !== 'file' ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        !Number.isFinite(value.mtimeMs ?? value.mtime)
      ) {
        throw new Error('Transcript unavailable')
      }
      const mtimeMs = value.mtimeMs ?? value.mtime
      const identity =
        Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino)
          ? `${value.dev}:${value.ino}`
          : `remote:${value.size}:${mtimeMs}`
      return {
        identity,
        size: value.size,
        mtimeMs,
        // Remote provider stats do not expose ctime; mtime still detects writes
        // while identity and boundary checks cover replacement.
        ctimeMs: mtimeMs
      }
    },
    async open(filePath) {
      const provider = await authorize()
      return {
        async read(offset, length) {
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > MAX_TRANSCRIPT_SOURCE_READ_BYTES
          ) {
            throw new Error('Invalid transcript read range')
          }
          if (!provider.readFileChunk) {
            throw new Error('Remote bounded transcript reads unavailable')
          }
          const result = await provider.readFileChunk(filePath, offset, length)
          const maxEncodedLength = Math.ceil(length / 3) * 4 + 4
          if (
            typeof result.contentBase64 !== 'string' ||
            result.contentBase64.length > maxEncodedLength
          ) {
            throw new Error('Remote provider returned an invalid transcript chunk')
          }
          const buffer = Buffer.from(result.contentBase64, 'base64')
          if (
            !Number.isSafeInteger(result.bytesRead) ||
            result.bytesRead < 0 ||
            result.bytesRead > length ||
            buffer.byteLength !== result.bytesRead
          ) {
            throw new Error('Remote provider returned an invalid transcript chunk')
          }
          return buffer
        },
        async close() {}
      }
    }
  }
}
