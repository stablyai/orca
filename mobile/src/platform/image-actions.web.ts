import { useMemo } from 'react'
import { readRasterImageDataUri } from '../../../src/shared/image-data-uri'
import type {
  BridgeImageOperation,
  BridgeImageRunParams
} from '../mobile-web-shell/bridge/bridge-image-verbs'
import {
  NativeVerbError,
  useNativeVerbs,
  type NativeVerbs
} from '../mobile-web-shell/bridge/use-native-verbs'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'
import {
  ImageActionRefusedError,
  type ImageAction,
  type ImageActions
} from './image-actions-contract'

// Whole four-character groups per chunk keep each one canonical base64 and its byte offset exact.
async function stageInChunks(verbs: NativeVerbs, unpadded: string): Promise<number> {
  // Browsers draw unpadded data URIs, but the shell takes only canonical base64.
  const base64 = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const chunkChars = MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
  for (let start = 0; start < base64.length; start += chunkChars) {
    await verbs.stageImage((start / 4) * 3, base64.slice(start, start + chunkChars))
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

function refusal(error: unknown): unknown {
  if (!(error instanceof NativeVerbError)) {
    return error
  }
  if (error.reason === 'native_image_permission_denied') {
    return new ImageActionRefusedError('photos-access-denied', error.message)
  }
  return error.reason === 'native_media_too_large'
    ? new ImageActionRefusedError('too-large', error.message)
    : error
}

// The shell stages one image at a time, so every action in this document waits for the one before it, even from a closed viewer.
let previous: Promise<unknown> = Promise.resolve()

// The phone cannot save an SVG; drop the ones the URL names before offering actions that would fail.
function isWebRaster(uri: string): boolean {
  try {
    const url = new URL(uri)
    return url.protocol === 'https:' && !/\.svgz?$/i.test(url.pathname)
  } catch {
    return false
  }
}

// The page holds host and inline images as base64 data URIs and stages them; the shell downloads web images itself.
function imageAction(verbs: NativeVerbs, uri: string): ImageAction | null {
  const data = readRasterImageDataUri(uri)
  if (!data && !isWebRaster(uri)) {
    return null
  }
  const act = async (operation: BridgeImageOperation) => {
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
export function useImageActions(): ImageActions | null {
  const verbs = useNativeVerbs()
  return useMemo(
    () => (verbs.canActOnImages ? { forImage: (uri) => imageAction(verbs, uri) } : null),
    [verbs]
  )
}
