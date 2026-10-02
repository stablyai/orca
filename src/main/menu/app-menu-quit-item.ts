import { translateMain } from '../i18n/main-i18n'

export function createAppMenuQuitItem(
  onQuit?: () => void,
  platform: NodeJS.Platform = process.platform
): Electron.MenuItemConstructorOptions {
  const isMac = platform === 'darwin'
  const label = translateMain(isMac ? 'menu.quit' : 'menu.exit', isMac ? 'Quit' : 'Exit')
  if (!onQuit) {
    return isMac ? { role: 'quit' } : { role: 'quit', label }
  }
  return {
    label,
    click: onQuit,
    accelerator: isMac || platform === 'linux' ? 'CommandOrControl+Q' : undefined
  }
}
