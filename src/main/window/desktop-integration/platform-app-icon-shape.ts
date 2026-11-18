import { nativeImage } from 'electron'
import {
  composeMacAppIconBitmap,
  getMacAppIconTileGeometry,
  isFullBleedIconBitmap
} from './mac-app-icon-template'

/**
 * macOS draws Dock tiles exactly as given, so full-bleed square art gets Apple's icon shape,
 * margin and shadow to sit like its neighbours. Already-shaped art and other platforms pass through.
 */
export function fitAppIconToPlatformShape(
  image: Electron.NativeImage,
  // Classify at the image's own resolution so a smaller preview matches what the Dock draws.
  outputSide = image.getSize().width
): Electron.NativeImage {
  const { width, height } = image.getSize()
  if (process.platform !== 'darwin' || image.isEmpty() || width !== height) {
    return image
  }
  const bitmap = image.toBitmap()
  if (bitmap.length !== width * width * 4 || !isFullBleedIconBitmap(bitmap, width)) {
    return image
  }
  const geometry = getMacAppIconTileGeometry(outputSide)
  const tileBitmap = image
    .resize({ width: geometry.tileSide, height: geometry.tileSide, quality: 'best' })
    .toBitmap()
  if (tileBitmap.length !== geometry.tileSide * geometry.tileSide * 4) {
    return image
  }
  const shaped = composeMacAppIconBitmap(tileBitmap, geometry)
  return nativeImage.createFromBitmap(Buffer.from(shaped.buffer), {
    width: outputSide,
    height: outputSide
  })
}
