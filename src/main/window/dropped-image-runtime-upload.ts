import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { IMAGE_FILE_EXTENSIONS } from '../../shared/image-file-extensions'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'

const IMAGE_FILE_EXTENSION_SET = new Set(IMAGE_FILE_EXTENSIONS)

/**
 * A dropped image file's bytes, saved where a remote terminal tab's agent can
 * read them: the paired server's own temp dir, through the same chunked
 * `clipboard.*` upload the remote clipboard-image paste uses (no orcad change).
 * The server names every upload `orca-paste-*.png`, so the chip shows the same
 * friendly label a remote paste does instead of the dropped basename.
 */
export async function saveDroppedImageFileInRuntime(
  userDataPath: string,
  runtimeEnvironmentId: string,
  filePath: string
): Promise<string> {
  if (!IMAGE_FILE_EXTENSION_SET.has(extname(filePath).toLowerCase())) {
    throw new Error('Only image files can be attached to a remote session')
  }
  // Why stat first: the byte guard below only runs after a read, and a dropped
  // raw photo must be refused before its bytes are ever buffered.
  const size = (await stat(filePath)).size
  assertClipboardImageByteLengthWithinLimit(size)
  const buffer = await readFile(filePath)
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  return saveClipboardImageBufferInRuntime(userDataPath, runtimeEnvironmentId, buffer, null)
}
