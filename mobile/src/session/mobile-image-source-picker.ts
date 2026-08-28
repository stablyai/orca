import * as DocumentPicker from 'expo-document-picker'
import { File as FsFile } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import {
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit
} from '../../../src/shared/clipboard-image'
import { MobileImageBase64Accumulator } from './mobile-image-base64-accumulator'

export type MobileImageSource = 'library' | 'files'

export type PickedMobileImage = {
  // Raw base64 (no data: prefix); fed straight into the existing upload pipeline.
  readonly base64: string
  // Local file URI of the picked asset — used only to render a composer preview
  // thumbnail (the host upload uses `base64`); absent when the source can't supply one.
  readonly uri?: string
}

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super('Photo library permission denied')
    this.name = 'ImageLibraryPermissionError'
  }
}

const MOBILE_IMAGE_READ_CHUNK_BYTES = 256 * 1024

type MobileImageFileHandle = {
  readonly size: number | null
  readBytes(length: number): Uint8Array
  close(): void
}

type MobileImageFile = {
  readonly size: number
  open(): MobileImageFileHandle
}

export type MobileImageFileFactory = (uri: string) => MobileImageFile

function defaultMobileImageFileFactory(uri: string): MobileImageFile {
  return new FsFile(uri)
}

async function readUriAsBase64(
  uri: string,
  declaredSize: number | undefined,
  createFile: MobileImageFileFactory
): Promise<string> {
  if (typeof declaredSize === 'number' && Number.isFinite(declaredSize)) {
    assertClipboardImageByteLengthWithinLimit(declaredSize)
  }

  const file = createFile(uri)
  assertClipboardImageByteLengthWithinLimit(file.size)
  const handle = file.open()
  try {
    if (handle.size !== null) {
      assertClipboardImageByteLengthWithinLimit(handle.size)
    }
    const accumulator = new MobileImageBase64Accumulator()
    let bytesRead = 0
    while (bytesRead <= CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
      const requested = Math.min(
        MOBILE_IMAGE_READ_CHUNK_BYTES,
        CLIPBOARD_IMAGE_MAX_SOURCE_BYTES - bytesRead + 1
      )
      const bytes = handle.readBytes(requested)
      if (bytes.byteLength === 0) {
        break
      }
      bytesRead += bytes.byteLength
      assertClipboardImageByteLengthWithinLimit(bytesRead)
      accumulator.append(bytes)
    }
    const base64 = accumulator.finish()
    assertClipboardImageBase64LengthWithinLimit(base64.length)
    return base64
  } finally {
    handle.close()
  }
}

async function* pickFromLibrary(
  multiple: boolean,
  requestPermission: typeof ImagePicker.requestMediaLibraryPermissionsAsync = ImagePicker.requestMediaLibraryPermissionsAsync,
  launch: typeof ImagePicker.launchImageLibraryAsync = ImagePicker.launchImageLibraryAsync,
  createFile: MobileImageFileFactory = defaultMobileImageFileFactory
): AsyncGenerator<PickedMobileImage> {
  const permission = await requestPermission()
  // Why: `granted` covers full + limited iOS access; only a hard denial blocks us.
  if (!permission.granted) {
    throw new ImageLibraryPermissionError()
  }
  const result = await launch({
    mediaTypes: ['images'],
    base64: false,
    allowsMultipleSelection: multiple,
    ...(multiple ? { selectionLimit: 0, orderedSelection: true } : {}),
    quality: 1
  })
  if (result.canceled) {
    return
  }
  for (const asset of result.assets) {
    if (!asset.uri) {
      continue
    }
    const base64 = await readUriAsBase64(asset.uri, asset.fileSize, createFile)
    if (base64) {
      yield { base64, uri: asset.uri }
    }
  }
}

async function* pickFromFiles(
  multiple: boolean,
  launch: typeof DocumentPicker.getDocumentAsync = DocumentPicker.getDocumentAsync,
  createFile: MobileImageFileFactory = defaultMobileImageFileFactory
): AsyncGenerator<PickedMobileImage> {
  const result = await launch({
    type: 'image/*',
    multiple,
    copyToCacheDirectory: true
  })
  if (result.canceled) {
    return
  }
  for (const asset of result.assets) {
    if (!asset.uri) {
      continue
    }
    const base64 = await readUriAsBase64(asset.uri, asset.size, createFile)
    if (base64) {
      yield { base64, uri: asset.uri }
    }
  }
}

type MobileImagePickerDeps = {
  readonly requestLibraryPermission?: typeof ImagePicker.requestMediaLibraryPermissionsAsync
  readonly launchLibrary?: typeof ImagePicker.launchImageLibraryAsync
  readonly launchFiles?: typeof DocumentPicker.getDocumentAsync
  readonly createFile?: MobileImageFileFactory
}

function pickMobileImagesWithMode(
  source: MobileImageSource,
  multiple: boolean,
  deps?: MobileImagePickerDeps
): AsyncIterable<PickedMobileImage> {
  if (source === 'library') {
    return pickFromLibrary(
      multiple,
      deps?.requestLibraryPermission,
      deps?.launchLibrary,
      deps?.createFile
    )
  }
  return pickFromFiles(multiple, deps?.launchFiles, deps?.createFile)
}

export async function pickMobileImage(
  source: MobileImageSource,
  deps?: MobileImagePickerDeps
): Promise<PickedMobileImage | null> {
  for await (const image of pickMobileImagesWithMode(source, false, deps)) {
    return image
  }
  return null
}

export function pickMobileImages(
  source: MobileImageSource,
  deps?: MobileImagePickerDeps
): AsyncIterable<PickedMobileImage> {
  return pickMobileImagesWithMode(source, true, deps)
}
