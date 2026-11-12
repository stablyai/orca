import { useMemo } from 'react'
import {
  agentSessionAttachmentAppends,
  base64DecodedByteLength
} from '../../../src/shared/agent-session/agent-session-attachments'
import { readRasterImageDataUri } from '../../../src/shared/file-preview/image-data-uri'
import { isKnownRasterImageMimeType } from '../../../src/shared/file-preview/raster-image-preview-limits'
import { isSvgFilePath } from '../../../src/shared/file-preview/svg-document'
import type {
  BridgeImageOperation,
  BridgeImageRunParams
} from '../mobile-web-shell/bridge/bridge-image-verbs'
import {
  NativeVerbError,
  useNativeVerbs,
  type NativeVerbReason,
  type NativeVerbs
} from '../mobile-web-shell/bridge/use-native-verbs'
import {
  ImageActionRefusedError,
  type ImageAction,
  type ImageActionRefusal,
  type ImageActionsFor
} from './image-actions-contract'

// Same 512 KiB base64 chunks as attachment uploads: whole four-character groups keep each chunk canonical and its offset exact.
async function stageInChunks(verbs: NativeVerbs, unpadded: string): Promise<number> {
  // Browsers draw unpadded data URIs, but the shell takes only canonical base64.
  const base64 = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  for (const chunk of agentSessionAttachmentAppends(base64)) {
    await verbs.stageImage(chunk.offset, chunk.contentBase64)
  }
  return base64DecodedByteLength(base64)
}

const REFUSALS: Partial<Record<NativeVerbReason, ImageActionRefusal>> = {
  native_image_permission_denied: 'photos-access-denied',
  native_media_too_large: 'too-large'
}

function refusal(error: unknown): unknown {
  const reason = error instanceof NativeVerbError ? REFUSALS[error.reason] : undefined
  return reason && error instanceof Error
    ? new ImageActionRefusedError(reason, error.message)
    : error
}

// Reads only the header, so opening a large image does not copy its payload before a tap.
function isRasterDataUri(uri: string): boolean {
  const mime = /^data:([^;,]+);base64,/i.exec(uri.slice(0, 256))?.[1]
  return isKnownRasterImageMimeType(mime)
}

// The phone cannot save an SVG; drop the ones the URL names before offering actions that would fail.
function isWebRaster(uri: string): boolean {
  try {
    const url = new URL(uri)
    return url.protocol === 'https:' && !isSvgFilePath(url.pathname)
  } catch {
    return false
  }
}

// The shell stages one image at a time, so every action in this document waits for the one before it, even from a closed viewer.
let previous: Promise<unknown> = Promise.resolve()

// The page holds host and inline images as base64 data URIs and stages them; the shell downloads web images itself.
function imageAction(verbs: NativeVerbs, uri: string): ImageAction | null {
  const inline = isRasterDataUri(uri)
  if (!inline && !isWebRaster(uri)) {
    return null
  }
  const act = async (operation: BridgeImageOperation) => {
    const data = inline ? readRasterImageDataUri(uri) : null
    if (inline && !data) {
      throw new Error('the image has no bytes')
    }
    try {
      const source: BridgeImageRunParams['source'] = data
        ? {
            kind: 'staged',
            mime: data.mimeType,
            byteLength: await stageInChunks(verbs, data.base64)
          }
        : { kind: 'url', url: uri }
      await verbs.runImageAction({ operation, source })
    } catch (error) {
      throw refusal(error)
    }
  }
  return (operation) => {
    const next = previous.then(() => act(operation))
    previous = next.catch(() => {})
    return next
  }
}

// Older shells lack native.image.act, so callers get null and offer no image actions.
export function useImageActions(): ImageActionsFor | null {
  const verbs = useNativeVerbs()
  return useMemo(
    () => (verbs.canActOnImages ? (uri: string) => imageAction(verbs, uri) : null),
    [verbs]
  )
}
