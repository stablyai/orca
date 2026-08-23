import * as DocumentPicker from 'expo-document-picker'
import { File as FsFile } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
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
export const MOBILE_IMAGE_DOWNSAMPLE_SOURCE_BYTES = 4 * 1024 * 1024
export const MOBILE_IMAGE_DOWNSAMPLE_MAX_EDGE = 2048
export const MOBILE_IMAGE_DOWNSAMPLE_TARGET_BASE64 = 8 * 1024 * 1024
export const MOBILE_IMAGE_QUALITY_LADDER = [0.82, 0.68, 0.52] as const

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

type PreparedMobileImage = { base64: string; uri: string }
type PrepareMobileImage = (input: {
  uri: string
  fileSize?: number
  width?: number
  height?: number
}) => Promise<PreparedMobileImage | null>

function defaultMobileImageFileFactory(uri: string): MobileImageFile {
  return new FsFile(uri)
}

export function shouldDownsampleMobileImage(input: {
  fileSize?: number
  width?: number
  height?: number
}): boolean {
  return (
    (input.fileSize ?? 0) > MOBILE_IMAGE_DOWNSAMPLE_SOURCE_BYTES ||
    Math.max(input.width ?? 0, input.height ?? 0) > MOBILE_IMAGE_DOWNSAMPLE_MAX_EDGE
  )
}

export async function prepareMobileImageForUpload(
  input: {
    uri: string
    fileSize?: number
    width?: number
    height?: number
  },
  deletePreparedFile: (uri: string) => void = (uri) => new FsFile(uri).delete()
): Promise<PreparedMobileImage | null> {
  if (!shouldDownsampleMobileImage(input)) {
    return null
  }
  let last: PreparedMobileImage | null = null
  for (const [attempt, compress] of MOBILE_IMAGE_QUALITY_LADDER.entries()) {
    const scale = 0.8 ** attempt
    const width = Math.max(1, Math.round(MOBILE_IMAGE_DOWNSAMPLE_MAX_EDGE * scale))
    const context = ImageManipulator.manipulate(input.uri)
    const sourceWidth = input.width ?? 0
    const sourceHeight = input.height ?? 0
    if (sourceWidth > 0 && sourceHeight > 0) {
      const edgeScale = Math.min(1, width / Math.max(sourceWidth, sourceHeight))
      context.resize({
        width: Math.max(1, Math.round(sourceWidth * edgeScale)),
        height: Math.max(1, Math.round(sourceHeight * edgeScale))
      })
    }
    const rendered = await context.renderAsync()
    try {
      const result = await rendered.saveAsync({
        format: SaveFormat.PNG,
        compress,
        base64: true
      })
      if (!result.base64) {
        throw new Error('Failed to encode resized image')
      }
      if (last) {
        try {
          deletePreparedFile(last.uri)
        } catch {
          // Cache cleanup is best effort; the OS reclaims it independently.
        }
      }
      last = { base64: result.base64, uri: result.uri }
      if (result.base64.length <= MOBILE_IMAGE_DOWNSAMPLE_TARGET_BASE64) {
        return last
      }
    } finally {
      rendered.release()
      context.release()
    }
  }
  if (last) {
    assertClipboardImageBase64LengthWithinLimit(last.base64.length)
  }
  return last
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
  createFile: MobileImageFileFactory = defaultMobileImageFileFactory,
  prepareImage: PrepareMobileImage = prepareMobileImageForUpload
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
    const prepared = await prepareImage({
      uri: asset.uri,
      fileSize: asset.fileSize,
      width: asset.width,
      height: asset.height
    })
    const base64 =
      prepared?.base64 ?? (await readUriAsBase64(asset.uri, asset.fileSize, createFile))
    if (base64) {
      yield { base64, uri: prepared?.uri ?? asset.uri }
    }
  }
}

async function* pickFromFiles(
  multiple: boolean,
  launch: typeof DocumentPicker.getDocumentAsync = DocumentPicker.getDocumentAsync,
  createFile: MobileImageFileFactory = defaultMobileImageFileFactory,
  prepareImage: PrepareMobileImage = prepareMobileImageForUpload
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
    const prepared = await prepareImage({ uri: asset.uri, fileSize: asset.size })
    const base64 = prepared?.base64 ?? (await readUriAsBase64(asset.uri, asset.size, createFile))
    if (base64) {
      yield { base64, uri: prepared?.uri ?? asset.uri }
    }
  }
}

type MobileImagePickerDeps = {
  readonly requestLibraryPermission?: typeof ImagePicker.requestMediaLibraryPermissionsAsync
  readonly launchLibrary?: typeof ImagePicker.launchImageLibraryAsync
  readonly launchFiles?: typeof DocumentPicker.getDocumentAsync
  readonly createFile?: MobileImageFileFactory
  readonly prepareImage?: PrepareMobileImage
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
      deps?.createFile,
      deps?.prepareImage
    )
  }
  return pickFromFiles(multiple, deps?.launchFiles, deps?.createFile, deps?.prepareImage)
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
