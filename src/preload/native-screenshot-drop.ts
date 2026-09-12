import { assertClipboardImageByteLengthWithinLimit } from '../shared/clipboard-image'
import type { NativeFileDropPayload } from '../shared/native-file-drop'

type DroppedFile = Pick<File, 'size' | 'arrayBuffer'>

const screenshotPath =
  /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/TemporaryItems\/NSIRD_screencaptureui_[^/]+\/[^/]+\.(?:png|jpe?g|tiff?|heic)$/i

export async function preserveNativeScreenshotDrop(
  payload: NativeFileDropPayload,
  files: ReadonlyMap<string, DroppedFile>,
  platform: string,
  saveImage: (bytes: Uint8Array) => Promise<string>
): Promise<NativeFileDropPayload> {
  if (platform !== 'darwin' || (payload.target !== 'terminal' && payload.target !== 'composer')) {
    return payload
  }

  const paths: string[] = []
  for (const sourcePath of payload.paths) {
    const file = files.get(sourcePath)
    if (!file || !screenshotPath.test(sourcePath)) {
      paths.push(sourcePath)
      continue
    }
    assertClipboardImageByteLengthWithinLimit(file.size)
    // Chromium can read the dropped File even when CLI processes cannot open its macOS path.
    const bytes = new Uint8Array(await file.arrayBuffer())
    assertClipboardImageByteLengthWithinLimit(bytes.byteLength)
    paths.push(await saveImage(bytes))
  }
  return { ...payload, paths }
}
