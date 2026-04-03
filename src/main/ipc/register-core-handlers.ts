import type { Store } from '../persistence'
import { registerFilesystemHandlers } from './filesystem'
import { registerGitHubHandlers } from './github'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerShellHandlers } from './shell'
import { registerUIHandlers } from './ui'
import { warmSystemFontFamilies } from '../system-fonts'
import {
  registerClipboardHandlers,
  registerUpdaterHandlers
} from '../window/attach-main-window-services'

export function registerCoreHandlers(store: Store): void {
  registerGitHubHandlers(store)
  registerSettingsHandlers(store)
  registerShellHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerFilesystemHandlers(store)
  registerClipboardHandlers()
  registerUpdaterHandlers(store)
  warmSystemFontFamilies()
}
