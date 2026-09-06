import * as Clipboard from 'expo-clipboard'
import {
  normalizeMobileClipboardImageBase64,
  prepareMobileClipboardImageBase64,
  MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  type MobileClipboardImage,
  type MobileClipboardImageResizer
} from './mobile-clipboard-image'

export const MOBILE_TERMINAL_PASTE_RESERVED_BYTES = 256 * 1024

type ClipboardSnapshot = { text: string; image: MobileClipboardImage | null }
let retainedImageCharacters = 0
let activeImagePreparations = 0
const MAX_IMAGE_PREPARATIONS = 4

export function captureMobileTerminalClipboard(resize: MobileClipboardImageResizer) {
  let disposed = false
  let snapshot: ClipboardSnapshot | undefined
  let failure: { error: unknown } | undefined
  let imageCharacters = 0
  // Resolve to void so a cancelled read cannot retain clipboard data in its promise.
  const ready = (async () => {
    const text = await Clipboard.getStringAsync()
    if (disposed) {
      return
    }
    if (
      text.length > MOBILE_TERMINAL_PASTE_RESERVED_BYTES ||
      new TextEncoder().encode(text).byteLength > MOBILE_TERMINAL_PASTE_RESERVED_BYTES
    ) {
      throw new Error('Clipboard text is too large')
    }
    if (text) {
      snapshot = { text, image: null }
      return
    }
    if (activeImagePreparations >= MAX_IMAGE_PREPARATIONS) {
      throw new Error('Too many clipboard image preparations pending')
    }
    activeImagePreparations += 1
    try {
      const image = await Clipboard.getImageAsync({ format: 'png' })
      if (disposed) {
        return
      }
      if (!image) {
        snapshot = { text, image: null }
        return
      }
      const data = normalizeMobileClipboardImageBase64(
        await prepareMobileClipboardImageBase64(image, async (source, target) => {
          if (disposed) {
            throw new Error('Clipboard snapshot cancelled')
          }
          return resize(source, target)
        })
      )
      if (!disposed) {
        if (retainedImageCharacters + data.length > MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS) {
          throw new Error('Too much clipboard image data pending')
        }
        imageCharacters = data.length
        retainedImageCharacters += imageCharacters
        snapshot = { text, image: { ...image, data } }
      }
    } finally {
      activeImagePreparations -= 1
    }
  })().catch((error: unknown) => {
    if (!disposed) {
      failure = { error }
    }
  })
  return {
    async read(): Promise<ClipboardSnapshot | undefined> {
      await ready
      if (failure) {
        throw failure.error
      }
      return snapshot
    },
    dispose() {
      disposed = true
      retainedImageCharacters -= imageCharacters
      imageCharacters = 0
      snapshot = undefined
      failure = undefined
    }
  }
}
