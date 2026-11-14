import type { PluginWorkerFactory } from './workers/worker-supervision/plugin-worker-startup'
import type { KeybindingOverrides } from '../../shared/keybindings/types'
import type { PluginKillListEntry } from '../../shared/plugins/catalog/plugin-kill-list'
import type { PluginDesktopFrameServices } from './workers/host-api/plugin-host-method-bindings'
import type { PluginStatusBarState } from './status-bar/plugin-status-bar-state'
import type { PluginAppearanceService } from './appearance/plugin-appearance-service'
import type { PluginEditorTypographySource } from './appearance/plugin-editor-typography'

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
  appearance?: PluginAppearanceService
  /** What `editor.readTypography` answers; absent where no profile settings are loaded. */
  editorTypography?: PluginEditorTypographySource
}
