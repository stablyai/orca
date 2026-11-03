import type { PluginWorkerFactory } from './workers/plugin-worker-manager'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { PluginKillListEntry } from '../../shared/plugins/catalog/plugin-kill-list'
import type { PluginDesktopFrameServices } from './workers/plugin-host-method-bindings'
import type { PluginStatusBarState } from './status-bar/plugin-status-bar-state'
import type { PluginCardFieldsState } from './cards/plugin-card-fields-state'

export type PluginServiceOptions = {
  userDataPath: string
  hostVersion: string
  isPluginSystemEnabled: () => boolean
  getDisabledPlugins: () => string[]
  getPluginConsents: () => Record<string, string>
  getDevPluginPaths: () => string[]
  getKeybindings?: () => KeybindingOverrides
  getPluginKillListEntry?: (pluginKey: string) => PluginKillListEntry | null
  hostEntryPath?: string
  /** Where this release's bundled plugins live; absent where nothing is shipped. */
  bundledPluginRoot?: string
  workerFactory?: PluginWorkerFactory
  maxActiveWorkers?: number
  idleReapMs?: number
  /** Desktop main only: the sinks behind `shell.openExternal` and `files.saveAs`. */
  getDesktopFrameServices?: () => PluginDesktopFrameServices | null
  /** Desktop main only: what `statusBar.update` writes for the windows' status bars. */
  statusBar?: PluginStatusBarState
  /** Desktop main only: what `cards.setFields` writes for the windows' workspace cards. */
  cardFields?: PluginCardFieldsState
}
