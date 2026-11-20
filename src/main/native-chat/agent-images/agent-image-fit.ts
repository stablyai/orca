import { readRasterImageDimensions } from '../../../shared/file-preview/raster-image-dimensions'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Animation, Image } from 'imagescript'
import {
  AGENT_IMAGE_MAX_LONG_EDGE,
  clipboardImageSizeWithinEdge,
  agentImageNeedsFitting,
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
  if (dimensions && !agentImageNeedsFitting(buffer.byteLength, dimensions)) {
    return path
  }
  const signature = detectImageFileSignature(buffer)
  if (!signature) {
    return path
  }
  const digest = createHash('sha256').update(buffer).digest('hex')
  const jpeg = signature.extension === 'jpg'
  const output = join(outputDirectory, `v2-${digest}.${jpeg ? 'jpg' : 'png'}`)
  try {
    await access(output)
    return output
  } catch {
    // The source digest makes each committed derivative immutable.
  }
  const options = { maxPixels: 64 * 1024 * 1024, threads: 1, gainMap: false }
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
  const decoded = image.resize(clipboardImageSizeWithinEdge(image, AGENT_IMAGE_MAX_LONG_EDGE))
  const encoded = await encodeAgentImageWithinLimit(
    decoded,
    (size) => {
      decoded.resize(size)
      return jpeg ? decoded.encodeJPEG({ quality: 85, gainMap: false }) : decoded.encodePNG()
    },
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
