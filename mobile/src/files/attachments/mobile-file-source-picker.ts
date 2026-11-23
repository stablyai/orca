import * as DocumentPicker from 'expo-document-picker'
import {
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type PickedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import {
  defaultMobileImageFileFactory,
  type MobileImageFileFactory
} from './mobile-image-source-picker'
import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'

const UNKNOWN_FILE_MIME = 'application/octet-stream'
const FILE_READ_CHUNK_BYTES = AGENT_SESSION_ATTACHMENT_CHUNK_BYTES

type MobileFilePickerDeps = {
  readonly launch?: typeof DocumentPicker.getDocumentAsync
  readonly createFile?: MobileImageFileFactory
}

// An oversized file stops the pick; files already yielded remain with the caller.
export async function* pickMobileFiles(
  deps?: MobileFilePickerDeps
): AsyncGenerator<PickedMobileFile> {
  const launch = deps?.launch ?? DocumentPicker.getDocumentAsync
  const createFile = deps?.createFile ?? defaultMobileImageFileFactory
  const result = await launch({ type: '*/*', multiple: true, copyToCacheDirectory: true })
  if (result.canceled) {
    return
  }
  for (const asset of result.assets) {
    if (!asset.uri) {
      continue
    }
    const name = asset.name.trim() || 'attachment'
    const file = createFile(asset.uri)
    const byteLength = file.size
    if (
      (typeof asset.size === 'number' && asset.size > MOBILE_PICKED_FILE_MAX_BYTES) ||
      !Number.isFinite(byteLength) ||
      byteLength > MOBILE_PICKED_FILE_MAX_BYTES
    ) {
      throw new MobileFileTooLargeError(name)
    }
    yield {
      name,
      mime: asset.mimeType ?? UNKNOWN_FILE_MIME,
      byteLength,
      readBytes: () => readFileBytes(file, byteLength)
    }
  }
}

// A file that changes size mid-read would commit something other than what was weighed, so refuse it.
async function* readFileBytes(
  file: ReturnType<MobileImageFileFactory>,
  byteLength: number
): AsyncGenerator<Uint8Array> {
  const handle = file.open()
  try {
    let read = 0
    for (;;) {
      const bytes = handle.readBytesSync(FILE_READ_CHUNK_BYTES)
      if (bytes.byteLength === 0) {
        break
      }
      read += bytes.byteLength
      if (read > byteLength) {
        throw new Error('The file grew while it was being attached')
      }
      yield bytes
    }
    if (read !== byteLength) {
      throw new Error('The file shrank while it was being attached')
    }
  } finally {
    handle.close()
  }
}
