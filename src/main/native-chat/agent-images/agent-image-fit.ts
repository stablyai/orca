import { readRasterImageDimensions } from '../../../shared/file-preview/raster-image-dimensions'
import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Animation, Image } from 'imagescript'
import type { AgentImageFitResult } from './agent-image-fit-protocol'
import { publishAgentImage } from './agent-image-publication'
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
  return publishAgentImage(await prepareAgentImageFile(path, outputDirectory))
}

export async function prepareAgentImageFile(
  path: string,
  outputDirectory: string
): Promise<AgentImageFitResult> {
  const { buffer } = await readNodeFileWithinLimit(path, AGENT_SESSION_ATTACHMENT_MAX_BYTES, {
    regularFileOnly: true
  })
  const dimensions = readRasterImageDimensions(buffer)
  if (dimensions && !agentImageNeedsFitting(buffer.byteLength, dimensions)) {
    return { path }
  }
  const signature = detectImageFileSignature(buffer)
  if (!signature) {
    return { path }
  }
  const digest = createHash('sha256').update(buffer).digest('hex')
  const jpeg = signature.extension === 'jpg'
  const uploadId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
  const output = join(outputDirectory, uploadId, `v2-${digest}.${jpeg ? 'jpg' : 'png'}`)
  try {
    await access(output)
    return { path: output }
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
    return { path }
  }
  if (!image) {
    return { path }
  }
  if (!agentImageNeedsFitting(buffer.byteLength, image)) {
    return { path }
  }
  const target = clipboardImageSizeWithinEdge(image, AGENT_IMAGE_MAX_LONG_EDGE)
  if (image.width !== target.width || image.height !== target.height) {
    image.resize(target)
  }
  const decoded = image
  const encoded = await encodeAgentImageWithinLimit(
    decoded,
    (size) => {
      if (decoded.width !== size.width || decoded.height !== size.height) {
        decoded.resize(size)
      }
      return jpeg ? decoded.encodeJPEG({ quality: 85, gainMap: false }) : decoded.encodePNG()
    },
    (bytes) => bytes.byteLength
  )
  return { path: output, bytes: encoded }
}
