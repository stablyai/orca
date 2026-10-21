import * as DocumentPicker from 'expo-document-picker'
import {
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type PickedMobileFile
} from '../platform/media-picker-contract'
import {
  defaultMobileImageFileFactory,
  readUriAsBase64,
  type MobileImageFileFactory
} from './mobile-image-source-picker'
import { base64DecodedByteLength } from '../../../src/shared/agent-session-attachments'

const UNKNOWN_FILE_MIME = 'application/octet-stream'

type MobileFilePickerDeps = {
  readonly launch?: typeof DocumentPicker.getDocumentAsync
  readonly createFile?: MobileImageFileFactory
}

/**
 * Files of any type from the OS document picker, each read whole.
 *
 * A file over the cap stops the pick with `MobileFileTooLargeError`; the files before it have
 * already been yielded and stay with the caller.
 */
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
    const base64 = await readUriAsBase64(asset.uri, asset.size, createFile, (byteLength) => {
      if (!Number.isFinite(byteLength) || byteLength > MOBILE_PICKED_FILE_MAX_BYTES) {
        throw new MobileFileTooLargeError(name)
      }
    })
    yield {
      name,
      mime: asset.mimeType ?? UNKNOWN_FILE_MIME,
      byteLength: base64DecodedByteLength(base64),
      base64
    }
  }
}
