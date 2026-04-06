import { registerCliHandlers } from './cli'
import { registerPreflightHandlers } from './preflight'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerFilesystemHandlers } from './filesystem'
import { registerGitHubHandlers } from './github'
import { registerRuntimeHandlers } from './runtime'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerShellHandlers } from './shell'
import { registerUIHandlers } from './ui'
import { warmSystemFontFamilies } from '../system-fonts'
import {
  registerClipboardHandlers,
  registerUpdaterHandlers
} from '../window/attach-main-window-services'

export function registerCoreHandlers(store: Store, runtime: OrcaRuntimeService): void {
  registerCliHandlers()
  registerPreflightHandlers()
  registerGitHubHandlers(store)
  registerSettingsHandlers(store)
  registerShellHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerFilesystemHandlers(store)
  registerRuntimeHandlers(runtime)
  registerClipboardHandlers()
  registerUpdaterHandlers(store)
  warmSystemFontFamilies()
}
