// Page-only: a picked photo, cropped on the WebView's canvas to the square 512 px PNG bots.avatar.upload takes.
import { BOT_AVATAR_SIZE, MAX_BOT_AVATAR_SOURCE_BYTES } from '../../../src/shared/bot-avatar'
import { encodeClipboardImageWithinLimit } from '../../../src/shared/clipboard/clipboard-image'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../src/shared/mobile-bridge/mobile-bridge-frame-bytes'
import { base64DecodedByteLength } from '../../../src/shared/agent-session/agent-session-attachments'
import {
  BOT_AVATAR_TOO_SMALL,
  drawSquareBotAvatar
} from '../../../src/shared/bots/bot-avatar-square'
import { detectImageFileSignature } from '../../../src/shared/file-content/image-file-signature'
import type { PickedMobileImage } from '../platform/media-picking/media-picker-contract'
import { decodeBase64Bytes } from '../transport/encryption/base64-byte-codec'
import { translate } from '../i18n/mobile-i18n'

// The page's one-frame cap, less room for the request around the picture.
const PHOTO_MAX_BASE64_CHARS = MOBILE_BRIDGE_MAX_FRAME_BYTES - 16 * 1024

/** The square drawn at `detail` px and back up to its own size, as base64 PNG. */
function softenedPng(square: HTMLCanvasElement, detail: number): string {
  let canvas = square
  if (detail < square.width) {
    const small = document.createElement('canvas')
    small.width = detail
    small.height = detail
    small.getContext('2d')?.drawImage(square, 0, 0, detail, detail)
    canvas = document.createElement('canvas')
    canvas.width = square.width
    canvas.height = square.height
    const context = canvas.getContext('2d')
    if (context) {
      // Whole pixels repeat, which PNG packs small; a smoothed upscale stays as large as the photo.
      context.imageSmoothingEnabled = false
      context.drawImage(small, 0, 0, square.width, square.height)
    }
  }
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/** Why a photo wasn't used, in the desktop picker's words. */
export class BotAvatarPhotoError extends Error {}

export async function botAvatarPngFromPhoto(photo: PickedMobileImage): Promise<string> {
  if (base64DecodedByteLength(photo.base64) > MAX_BOT_AVATAR_SOURCE_BYTES) {
    throw new BotAvatarPhotoError(translate('bots.picture.tooBig', 'That image is over 10 MB.'))
  }
  const signature = detectImageFileSignature(decodeBase64Bytes(photo.base64.slice(0, 16)))
  const image = new Image()
  image.src = `data:${signature?.mimeType ?? photo.mime ?? 'image/png'};base64,${photo.base64}`
  try {
    await image.decode()
    const square = drawSquareBotAvatar(image, image.naturalWidth, image.naturalHeight).canvas
    // One bridge request carries it, so a busy photo is softened until its PNG fits; the host
    // still gets 512 px.
    return await encodeClipboardImageWithinLimit(
      { width: BOT_AVATAR_SIZE, height: BOT_AVATAR_SIZE },
      (detail) => softenedPng(square, detail.width),
      (base64) => base64.length,
      PHOTO_MAX_BASE64_CHARS
    )
  } catch (error) {
    throw new BotAvatarPhotoError(
      error instanceof Error && error.message === BOT_AVATAR_TOO_SMALL
        ? translate('bots.picture.tooSmall', 'Too small. Use an image at least 128 px.')
        : translate('bots.picture.unreadable', "Orca can't read that image. Try PNG or JPEG.")
    )
  }
}
