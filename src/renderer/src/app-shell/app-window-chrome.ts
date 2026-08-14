import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/lib/desktop-window-chrome'

export const isMac = navigator.userAgent.includes('Mac')
const isWindows = !isMac && navigator.userAgent.includes('Windows')
export const shortcutPlatform: NodeJS.Platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'
// Why: Windows and Linux remove the native title bar so the renderer draws its own chrome; paired web clients run in a browser tab and must not.
export const hasCustomTitleBar = shouldRenderDesktopWindowChrome({
  platform: shortcutPlatform,
  isWebClient: isPairedWebClientWindow()
})
