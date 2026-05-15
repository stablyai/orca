import { ipcMain, nativeTheme } from 'electron'
import type { Store } from '../persistence'
import type { GlobalSettings, PersistedState } from '../../shared/types'
import { listSystemFontFamilies } from '../system-fonts'
import { previewGhosttyImport } from '../ghostty/index'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { track } from '../telemetry/client'
import { SETTINGS_CHANGED_WHITELIST, type SettingsChangedKey } from '../../shared/telemetry-events'
import type { AgentAwakeService } from '../agent-awake-service'

// Why: the whitelist is the source-of-truth for which keys we emit on. Casting
// to a Set once at module load lets the IPC handler's per-key membership
// check stay O(1) without re-coercing the readonly tuple on every call.
const SETTINGS_CHANGED_WHITELIST_SET = new Set<string>(SETTINGS_CHANGED_WHITELIST)

// Why: fields that appear in the View > Appearance submenu need the menu
// rebuilt after any update so the checkbox `checked` state stays in sync
// with the persisted value. Electron doesn't reactively re-render menu
// items when the backing state changes.
const APPEARANCE_MENU_KEYS: readonly (keyof GlobalSettings)[] = [
  'showTasksButton',
  'showTitlebarAppName'
]

export function registerSettingsHandlers(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
  ipcMain.handle('settings:get', () => {
    return store.getSettings()
  })

  ipcMain.handle('settings:set', (_event, args: Partial<GlobalSettings>) => {
    if (args.theme) {
      nativeTheme.themeSource = args.theme
    }
    // Why: capture the pre-update value so we only emit when the value
    // actually changes. The settings UI sometimes re-saves the same value
    // (e.g. blur after a no-op edit), and a `settings_changed` event for a
    // no-op flip would inflate the experimental-feature-adoption signal.
    const before = store.getSettings()
    const result = store.updateSettings(args)
    if ('keepComputerAwakeWhileAgentsRun' in args) {
      agentAwakeService?.setEnabled(result.keepComputerAwakeWhileAgentsRun)
    }
    if (APPEARANCE_MENU_KEYS.some((key) => key in args)) {
      rebuildAppMenu()
    }

    // Why: telemetry-plan.md§Settings — fire `settings_changed` only for
    // whitelisted keys, with `value_kind` distinguishing booleans from
    // string-enum settings. We deliberately do NOT send the raw value for
    // non-enum settings; the whitelist is currently scoped to experimental
    // toggles, all of which are booleans, so `value_kind === 'bool'` is
    // the path the v1 enum has a slot for. If a non-bool whitelisted
    // setting is ever added, extend the discriminator here at the same
    // time the schema's `value_kind` enum gains the new value.
    for (const key of Object.keys(args)) {
      if (!SETTINGS_CHANGED_WHITELIST_SET.has(key)) {
        continue
      }
      const beforeValue = (before as Record<string, unknown>)[key]
      const afterValue = (result as Record<string, unknown>)[key]
      if (beforeValue === afterValue) {
        continue
      }
      if (typeof afterValue !== 'boolean') {
        // No non-bool whitelist entries today; skip rather than guess.
        continue
      }
      track('settings_changed', {
        setting_key: key as SettingsChangedKey,
        value_kind: 'bool'
      })
    }

    return result
  })

  ipcMain.handle('settings:listFonts', () => {
    return listSystemFontFamilies()
  })

  ipcMain.handle('settings:previewGhosttyImport', () => {
    return previewGhosttyImport(store)
  })

  ipcMain.handle('cache:getGitHub', () => {
    return store.getGitHubCache()
  })

  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    store.setGitHubCache(args.cache)
  })
}
