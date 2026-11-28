import { nativeImage, type NativeImage } from 'electron'
import menuBarIconPath from '../../../resources/tray/orca-menu-barTemplate.png?asset&asarUnpack'
import menuBarIconRetinaPath from '../../../resources/tray/orca-menu-barTemplate@2x.png?asset&asarUnpack'
import { stampTrayDevBadge } from './tray-dev-badge'

export function createMacMenuBarImage(): NativeImage | null {
  const image = nativeImage.createFromPath(menuBarIconPath)
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) {
    console.warn('[system-tray] macOS menu bar icon could not be loaded')
    return null
  }

  const retinaImage = nativeImage.createFromPath(menuBarIconRetinaPath)
  const retinaSize = retinaImage.getSize()
  if (retinaSize.width > 0 && retinaSize.height > 0) {
    try {
      // Import/package the 2x asset explicitly instead of relying on bundler-renamed siblings.
      image.addRepresentation({
        scaleFactor: 2,
        dataURL: retinaImage.toDataURL()
      })
    } catch (error) {
      // Bad 2x data may blur Retina but must not abort tray creation.
      console.warn('[system-tray] macOS retina menu bar icon could not be added', error)
    }
  } else {
    // Report degraded Retina rendering so blurry status icons remain diagnosable.
    console.warn('[system-tray] macOS retina menu bar icon could not be loaded')
  }
  image.setTemplateImage(true)
  return image
}

// Badge dev pixels inside the production-width template; attention tint inherits them, unlike a separate tray title.
export function stampMacDevBadge(base: NativeImage): NativeImage {
  try {
    const stamped = stampTrayDevBadge(base)
    if (base.getScaleFactors().includes(2)) {
      // Bitmap creation drops 2x data; rebuild it so the dev badge stays sharp on Retina.
      const retinaStamped = stampTrayDevBadge(base, 2)
      stamped.addRepresentation({
        scaleFactor: 2,
        dataURL: retinaStamped.toDataURL()
      })
    }
    stamped.setTemplateImage(true)
    return stamped
  } catch (error) {
    // Diagnostic dev badges must degrade to the plain icon rather than abort creation.
    console.warn('[system-tray] dev badge could not be stamped; showing plain icon', error)
    return base
  }
}
