import { app, nativeImage, type NativeImage, type OpenDialogOptions } from 'electron'
import { basename, extname } from 'node:path'
import { isOpenInAppIconImageSrc } from '../shared/open-in-app-icons'

export type PickedApplicationIcon = { dataUrl: string; label: string }

// Why: `size: 'large'` aborts the whole main process on macOS (Electron 43, native
// CHECK — not a rejected promise, so it cannot be caught).
const ICON_REQUEST_SIZE = 'normal'

// Why: the menus render at 14–16px, so 64 stays sharp at 2x while keeping the PNG
// small enough to ride inside global settings.
const ICON_MAX_PIXEL_SIZE = 64

async function loadApplicationIcon(filePath: string): Promise<NativeImage> {
  try {
    // Why: getFileIcon resolves icons by file *type*, so every .app bundle comes back
    // with one generic badge. The thumbnailer returns the bundle's own icon.
    return await nativeImage.createThumbnailFromPath(filePath, {
      width: ICON_MAX_PIXEL_SIZE,
      height: ICON_MAX_PIXEL_SIZE
    })
  } catch {
    // Linux has no thumbnailer, so a type icon is the best available there.
    return app.getFileIcon(filePath, { size: ICON_REQUEST_SIZE })
  }
}

/** What counts as "an application" differs per OS, so the picker's filter does too. */
export function applicationPickerOptions(platform: NodeJS.Platform): OpenDialogOptions {
  if (platform === 'darwin') {
    // Bundles are directories; leaving treatPackageAsDirectory unset picks the .app itself.
    return {
      properties: ['openFile'],
      defaultPath: '/Applications',
      filters: [{ name: 'Applications', extensions: ['app'] }]
    }
  }
  if (platform === 'win32') {
    return {
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
    }
  }
  return {
    properties: ['openFile'],
    filters: [
      { name: 'Applications', extensions: ['desktop', 'AppImage', 'sh'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

export function applicationLabelFromPath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

// Anything at or below this alpha is margin rather than artwork.
const TRANSPARENT_ALPHA = 8

/**
 * Flattens to the sharpest representation. Everything downstream works in real
 * pixels after this — `crop()` keeps only the 1x rep, so trimming the multi-rep
 * image directly would silently halve the resolution.
 */
function toFullResolutionImage(image: NativeImage): NativeImage {
  const scale = Math.max(...image.getScaleFactors())
  return scale > 1 ? nativeImage.createFromBuffer(image.toPNG({ scaleFactor: scale })) : image
}

/**
 * Crops the transparent margin macOS bakes around a squircle icon. Without it, a
 * tile like Android Studio's renders visibly smaller than an edge-to-edge mark
 * like VS Code's at the very same box size.
 */
function trimTransparentMargin(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  if (bitmap.length < width * height * 4) {
    return image
  }

  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // BGRA, so alpha is the 4th byte of each pixel.
      if (bitmap[(y * width + x) * 4 + 3] > TRANSPARENT_ALPHA) {
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
  }

  if (right < left || bottom < top) {
    return image
  }
  const cropped = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
  return cropped.width === width && cropped.height === height ? image : image.crop(cropped)
}

function scaleIconToBox(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  // Why: only downscale — upscaling past the pixels the OS gave us just blurs.
  if (Math.max(width, height) <= ICON_MAX_PIXEL_SIZE) {
    return image
  }
  // Why: passing a single dimension preserves the aspect ratio, so a non-square
  // mark is never stretched to fill the box.
  const bound = width >= height ? { width: ICON_MAX_PIXEL_SIZE } : { height: ICON_MAX_PIXEL_SIZE }
  return image.resize({ ...bound, quality: 'best' })
}

export async function extractApplicationIcon(filePath: string): Promise<PickedApplicationIcon> {
  const image = await loadApplicationIcon(filePath)
  if (image.isEmpty()) {
    throw new Error('Could not read an icon from that application.')
  }

  const artwork = trimTransparentMargin(toFullResolutionImage(image))
  const dataUrl = scaleIconToBox(artwork).toDataURL()
  if (!isOpenInAppIconImageSrc(dataUrl)) {
    throw new Error('That application icon is too large to store.')
  }

  return { dataUrl, label: applicationLabelFromPath(filePath) }
}
