import type {
  PickedMobileFile,
  PickedMobileImage,
  SharedMobileContent
} from '../platform/media-picker-contract'
import { isPickedImageMime } from '../platform/mobile-picked-file-name'
import { readMobileFile } from '../session/mobile-file-source-picker'
import {
  defaultMobileImageFileFactory,
  readUriAsBase64
} from '../session/mobile-image-source-picker'
import { takeIncomingShare, type IncomingShareFile } from './incoming-share'

async function* readSharedImages(
  files: readonly IncomingShareFile[]
): AsyncGenerator<PickedMobileImage> {
  for (const file of files) {
    yield {
      base64: await readUriAsBase64(file.uri, file.size, defaultMobileImageFileFactory),
      uri: file.uri
    }
  }
}

async function* readSharedFiles(
  files: readonly IncomingShareFile[]
): AsyncGenerator<PickedMobileFile> {
  for (const file of files) {
    yield await readMobileFile(file.uri, file)
  }
}

// The native picker's side of MediaPicker.takeShare; pages reach the same share through native.share.take.
export async function takeIncomingShareContent(accepts: {
  readonly images: boolean
  readonly files: boolean
}): Promise<SharedMobileContent | null> {
  const share = takeIncomingShare()
  if (!share) {
    return null
  }
  const images = share.files.filter((file) => accepts.images && isPickedImageMime(file.mimeType))
  const files = share.files.filter((file) => accepts.files && !isPickedImageMime(file.mimeType))
  return {
    text: share.text,
    images: images.length > 0 ? readSharedImages(images) : null,
    files: files.length > 0 ? readSharedFiles(files) : null,
    skipped: share.files.length - images.length - files.length
  }
}
