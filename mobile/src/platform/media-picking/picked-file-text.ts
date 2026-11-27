import { MobileFileTooLargeError, type PickedMobileFile } from './media-picker-contract'

const PICKED_TEXT_MAX_BYTES = 1024 * 1024

/** Small config files read as text; anything larger is refused before it is read. */
export async function readPickedFileText(
  file: PickedMobileFile,
  maxBytes: number = PICKED_TEXT_MAX_BYTES
): Promise<string> {
  if (file.byteLength > maxBytes) {
    throw new MobileFileTooLargeError(file.name, maxBytes)
  }
  const decoder = new TextDecoder()
  let text = ''
  for await (const bytes of file.readBytes()) {
    text += decoder.decode(bytes, { stream: true })
  }
  return text + decoder.decode()
}
