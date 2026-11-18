import { dialog } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { translateMain } from '../i18n/main-i18n'
import { getTrustedUIRendererWindow } from '../ipc/ui'

// Kill switch for automated launches that must never reach GitHub releases.
export const ZOTZ_DISABLE_UPDATER_ENV = 'ZOTZ_DISABLE_UPDATER'

let updatesEnabledSetting = true

/** Updates come from the fork's own releases (docs/zotz/UPDATES-SPEC.md); on unless turned off. */
export function isZotzUpdaterEnabled(): boolean {
  // E2E drivers install an old build; a real release installing over it pulls files from under the test.
  return (
    updatesEnabledSetting &&
    process.env[ZOTZ_DISABLE_UPDATER_ENV] !== '1' &&
    !process.env.ORCA_E2E_USER_DATA_DIR
  )
}

/** Read once when the updater starts; flipping the setting takes effect on the next launch. */
export function applyZotzUpdaterSetting(
  settings: Pick<GlobalSettings, 'zotzUpdatesEnabled'>
): void {
  updatesEnabledSetting = settings.zotzUpdatesEnabled !== false
}

export function showZotzUpdatesDisabledNotice(): void {
  const options = {
    type: 'info' as const,
    message: translateMain('zotz.updater.updatesOff', 'Zotz updates are turned off.'),
    detail: translateMain(
      'zotz.updater.updatesOffDetail',
      'Turn them on in Settings → Updates and restart Zotz.'
    )
  }
  const window = getTrustedUIRendererWindow()
  if (!window) {
    console.info(`[updater] ${options.message} ${options.detail}`)
    return
  }
  void dialog.showMessageBox(window, options)
}
