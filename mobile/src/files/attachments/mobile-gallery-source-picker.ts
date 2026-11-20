import { File as FsFile } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import {
  ImageLibraryPermissionError,
  MOBILE_STREAMED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type MobileGalleryPick,
  type PickedMobileFile,
  type PickedMobileImage
} from '../../platform/media-picking/media-picker-contract'
import { streamFileBase64Chunks } from './mobile-file-source-picker'
import { agentReadableLibraryImageOptions, readUriAsBase64 } from './mobile-image-source-picker'

type MobileGalleryPickerDeps = {
  readonly requestPermission?: typeof ImagePicker.requestMediaLibraryPermissionsAsync
  readonly launch?: typeof ImagePicker.launchImageLibraryAsync
  readonly createFile?: (uri: string) => FsFile
}

function videoFileName(uri: string, fileName: string | null | undefined): string {
  return fileName?.trim() || uri.split('/').at(-1) || 'video'
}

/** Photos and videos from one picker launch. Videos stay on disk and stream; the cache copy goes when the upload ends. */
export async function pickMobileGallery(
  deps?: MobileGalleryPickerDeps
): Promise<MobileGalleryPick> {
  const requestPermission =
    deps?.requestPermission ?? ImagePicker.requestMediaLibraryPermissionsAsync
  const launch = deps?.launch ?? ImagePicker.launchImageLibraryAsync
  const createFile = deps?.createFile ?? ((uri: string) => new FsFile(uri))
  if (!(await requestPermission()).granted) {
    throw new ImageLibraryPermissionError()
  }
  const result = await launch({
    mediaTypes: ['images', 'videos'],
    base64: false,
    allowsMultipleSelection: true,
    selectionLimit: 0,
    orderedSelection: true,
    ...agentReadableLibraryImageOptions()
  })
  if (result.canceled) {
    return { images: [], videos: [] }
  }
  const images: PickedMobileImage[] = []
  const videos: PickedMobileFile[] = []
  for (const asset of result.assets) {
    if (!asset.uri) {
      continue
    }
    if (asset.type !== 'video') {
      const base64 = await readUriAsBase64(asset.uri, asset.fileSize, createFile)
      if (base64) {
        images.push({ base64, uri: asset.uri })
      }
      continue
    }
    const file = createFile(asset.uri)
    const name = videoFileName(asset.uri, asset.fileName)
    if (!Number.isFinite(file.size) || file.size > MOBILE_STREAMED_FILE_MAX_BYTES) {
      file.delete?.()
      throw new MobileFileTooLargeError(name, MOBILE_STREAMED_FILE_MAX_BYTES)
    }
    videos.push({
      name,
      mime: asset.mimeType ?? 'video/quicktime',
      byteLength: file.size,
      chunks: () => streamFileBase64Chunks(file),
      dispose: () => {
        try {
          file.delete?.()
        } catch (error) {
          console.warn('[mobile-gallery] a picked cache copy could not be deleted', error)
        }
      }
    })
  }
  return { images, videos }
}
