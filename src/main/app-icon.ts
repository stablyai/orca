import { app, BrowserWindow, nativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import classicIcon from '../../resources/icon.png?asset'
import classicDevIcon from '../../resources/icon-dev.png?asset'
import watercolorIcon from '../../resources/app-icons/orca-watercolor.png?asset'
import blueIcon from '../../resources/app-icons/orca-blue.png?asset'
import { normalizeAppIconId, type AppIconId } from '../shared/app-icon'

const APP_ICON_PATHS = {
  classic: is.dev ? classicDevIcon : classicIcon,
  watercolor: watercolorIcon,
  blue: blueIcon
} satisfies Record<AppIconId, string>

export function getAppIconPath(value: unknown): string {
  return APP_ICON_PATHS[normalizeAppIconId(value)]
}

export function createAppIconImage(value: unknown): Electron.NativeImage {
  return nativeImage.createFromPath(getAppIconPath(value))
}

export function applyAppIcon(value: unknown): void {
  const image = createAppIconImage(value)
  if (image.isEmpty()) {
    return
  }
  if (process.platform === 'darwin') {
    app.dock?.setIcon(image)
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.setIcon(image)
    }
  }
}
