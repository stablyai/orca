import * as DocumentPicker from 'expo-document-picker'
import { File as FsFile } from 'expo-file-system'
import {
  MOBILE_STREAMED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type PickedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import { encodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'

const UNKNOWN_FILE_MIME = 'application/octet-stream'

type StreamedFileHandle = {
  offset: number | null
  readBytesSync(length: number): Uint8Array
  close(): void
}

export type StreamedFile = {
  readonly size: number
  open(): StreamedFileHandle
  delete?(): void
}

type MobileFilePickerDeps = {
  readonly launch?: typeof DocumentPicker.getDocumentAsync
  readonly createFile?: (uri: string) => StreamedFile
}

// Fill each chunk to a whole number of 3-byte groups so chunks encode to base64 independently.
export async function* streamFileBase64Chunks(file: StreamedFile): AsyncGenerator<string> {
  const handle = file.open()
  try {
    handle.offset = 0
    let remaining = file.size
    while (remaining > 0) {
      const want = Math.min(AGENT_SESSION_ATTACHMENT_CHUNK_BYTES, remaining)
      const buffer = new Uint8Array(want)
      let filled = 0
      while (filled < want) {
        const bytes = handle.readBytesSync(want - filled)
        if (bytes.byteLength === 0) {
          throw new Error('File ended before its reported size')
        }
        buffer.set(bytes, filled)
        filled += bytes.byteLength
      }
      remaining -= want
      yield encodeBase64Bytes(buffer)
    }
  } finally {
    handle.close()
  }
}

// An oversized file stops the pick; files already yielded remain with the caller. Cache copies are deleted on dispose or when iteration ends.
export async function* pickMobileFiles(
  deps?: MobileFilePickerDeps
): AsyncGenerator<PickedMobileFile> {
  const launch = deps?.launch ?? DocumentPicker.getDocumentAsync
  const createFile = deps?.createFile ?? ((uri: string): StreamedFile => new FsFile(uri))
  const result = await launch({ type: '*/*', multiple: true, copyToCacheDirectory: true })
  if (result.canceled) {
    return
  }
  const live = new Map<string, StreamedFile>()
  const discard = (uri: string): void => {
    const file = live.get(uri)
    live.delete(uri)
    try {
      file?.delete?.()
    } catch (error) {
      console.warn('[mobile-files] a picked cache copy could not be deleted', { uri }, error)
    }
  }
  for (const asset of result.assets) {
    if (asset.uri) {
      live.set(asset.uri, createFile(asset.uri))
    }
  }
  try {
    for (const asset of result.assets) {
      if (!asset.uri) {
        continue
      }
      const file = live.get(asset.uri)!
      const name = asset.name.trim() || 'attachment'
      if (!Number.isFinite(file.size) || file.size > MOBILE_STREAMED_FILE_MAX_BYTES) {
        throw new MobileFileTooLargeError(name, MOBILE_STREAMED_FILE_MAX_BYTES)
      }
      yield {
        name,
        mime: asset.mimeType ?? UNKNOWN_FILE_MIME,
        byteLength: file.size,
        chunks: () => streamFileBase64Chunks(file),
        dispose: () => discard(asset.uri)
      }
      discard(asset.uri)
    }
  } finally {
    for (const uri of live.keys()) {
      discard(uri)
    }
  }
}
