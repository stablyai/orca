import { readRasterImageDimensions } from '../../../shared/file-preview/raster-image-dimensions'
import { createHash } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Animation, Image } from 'imagescript'
import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_MAX_LONG_EDGE,
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
  const dimensions = readRasterImageDimensions(buffer)
  if (
    buffer.byteLength <= AGENT_IMAGE_MAX_BYTES &&
    (!dimensions || Math.max(dimensions.width, dimensions.height) <= AGENT_IMAGE_MAX_LONG_EDGE)
  ) {
    return path
  }
  const signature = detectImageFileSignature(buffer)
  if (!signature) {
    return path
  }
  const digest = createHash('sha256').update(buffer).digest('hex')
  const output = join(outputDirectory, `v1-${digest}.png`)
  try {
    await access(output)
    return output
  } catch {
    // The source digest makes each committed derivative immutable.
  }
  const options = { maxPixels: CLIPBOARD_IMAGE_MAX_PIXELS, threads: 1, gainMap: false }
  let image: Image | undefined
  try {
    image =
      signature.extension === 'gif' || signature.extension === 'webp'
        ? (await Animation.decode(buffer, { ...options, onlyFirstFrame: true })).frames[0]
        : await Image.decode(buffer, options)
  } catch {
    // Keep formats and large sources the provider can still read, as mobile does on decode failure.
    return path
  }
  if (!image) {
    return path
  }
  const decoded = image
  const encoded = await encodeAgentImageWithinLimit(
    decoded,
    (size) => decoded.clone().resize(size).encodePNG(),
    (bytes) => bytes.byteLength
  )
  await mkdir(outputDirectory, { recursive: true })
  const part = `${output}.part`
  try {
    await writeFile(part, encoded, { flag: 'w' })
    await rename(part, output)
  } finally {
    await rm(part, { force: true })
  }
  return output
}
