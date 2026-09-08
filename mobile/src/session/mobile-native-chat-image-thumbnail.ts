import { File as FsFile, Paths } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard-image'
import { MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import type { PickedMobileImage } from './mobile-image-source-picker'

const PREVIEW_WIDTHS = [192, 96, 48] as const
const PREVIEW_PREFIX = 'data:image/jpeg;base64,'
let previewFileSequence = 0

export async function createMobileNativeChatImagePreview(
  image: PickedMobileImage
): Promise<string> {
  const input = image.uri ? null : createInputFile(image.base64)
  const sourceUri = image.uri ?? input!.uri
  try {
    for (const width of PREVIEW_WIDTHS) {
      const preview = await renderPreview(sourceUri, width)
      if (
        preview &&
        PREVIEW_PREFIX.length + preview.length <=
          MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS
      ) {
        return `${PREVIEW_PREFIX}${preview}`
      }
    }
  } finally {
    deleteFile(input)
  }
  throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
}

async function renderPreview(sourceUri: string, width: number): Promise<string | null> {
  const context = ImageManipulator.manipulate(sourceUri)
  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | null = null
  let resultUri: string | null = null
  try {
    context.resize({ width })
    rendered = await context.renderAsync()
    const result = await rendered.saveAsync({
      base64: true,
      compress: 0.65,
      format: SaveFormat.JPEG
    })
    resultUri = result.uri
    return result.base64 ?? null
  } finally {
    rendered?.release()
    context.release()
    if (resultUri) {
      deleteFile(new FsFile(resultUri))
    }
  }
}

function createInputFile(base64: string): FsFile {
  previewFileSequence += 1
  const file = new FsFile(
    Paths.cache,
    `orca-native-chat-preview-${Date.now()}-${previewFileSequence}.png`
  )
  file.create({ overwrite: false })
  file.write(base64, { encoding: 'base64' })
  return file
}

function deleteFile(file: FsFile | null): void {
  if (!file) {
    return
  }
  try {
    file.delete()
  } catch {
    // The cache directory is reclaimed by the OS.
  }
}
