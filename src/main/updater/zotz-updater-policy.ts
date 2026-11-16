import { dialog } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { getTrustedUIRendererWindow } from '../ipc/ui'

export const ZOTZ_ENABLE_UPDATER_ENV = 'ZOTZ_ENABLE_UPDATER'

// Zotz ships from git; upstream Orca releases would overwrite the fork.
export function isZotzUpdaterEnabled(): boolean {
  return process.env[ZOTZ_ENABLE_UPDATER_ENV] === '1'
}

export function showZotzManualUpdateNotice(): void {
  const options = {
    type: 'info' as const,
    message: translateMain('zotz.updater.manualUpdate', 'Zotz updates with git pull + build.'),
    detail: translateMain(
      'zotz.updater.manualUpdateDetail',
      'See docs/zotz/UPDATE.md. Set ZOTZ_ENABLE_UPDATER=1 to turn the built-in updater back on.'
    )
  }
  const window = getTrustedUIRendererWindow()
  if (!window) {
    console.info(`[updater] ${options.message} ${options.detail}`)
    return
  }
  void dialog.showMessageBox(window, options)
}
