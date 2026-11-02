import type { PluginWorkerFactory } from './workers/plugin-worker-manager'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { PluginKillListEntry } from '../../shared/plugins/catalog/plugin-kill-list'
import type { PluginDesktopFrameServices } from './workers/plugin-host-method-bindings'

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
}
