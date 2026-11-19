import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Animation, Image } from 'imagescript'
import {
  AGENT_IMAGE_MAX_BYTES,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  encodeAgentImageWithinLimit
} from '../../../shared/clipboard/clipboard-image'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../shared/agent-session/agent-session-attachments'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import { detectImageFileSignature } from '../../../shared/file-content/image-file-signature'

/** Worker-only: keep decoding, scaling and compression off the host event loop. */
export async function fitAgentImageFile(path: string, outputDirectory: string): Promise<string> {
  const { buffer } = await readNodeFileWithinLimit(path, AGENT_SESSION_ATTACHMENT_MAX_BYTES, {
    regularFileOnly: true
  })
  if (buffer.byteLength <= AGENT_IMAGE_MAX_BYTES) {
    return path
  }
  const signature = detectImageFileSignature(buffer)
  if (!signature) {
    return path
  }
  const digest = createHash('sha256').update(buffer).digest('hex')
  const output = join(outputDirectory, `${digest}.png`)
  try {
    await access(output)
    return output
  } catch {
    // The source digest makes each committed derivative immutable.
  }
  const options = { maxPixels: CLIPBOARD_IMAGE_MAX_PIXELS, threads: 1, gainMap: false }
  const image =
    signature.extension === 'gif' || signature.extension === 'webp'
      ? (await Animation.decode(buffer, { ...options, onlyFirstFrame: true })).frames[0]
      : await Image.decode(buffer, options)
  if (!image) {
    throw new Error('Image has no frame')
  }
  const encoded = await encodeAgentImageWithinLimit(
    image,
    (size) => image.clone().resize(size).encodePNG(),
    (bytes) => bytes.byteLength
  )
  await mkdir(outputDirectory, { recursive: true })
  const part = join(outputDirectory, `${digest}-${randomUUID()}.part`)
  try {
    await writeFile(part, encoded, { flag: 'wx' })
    await rename(part, output)
  } finally {
    await rm(part, { force: true })
  }
  return output
}
