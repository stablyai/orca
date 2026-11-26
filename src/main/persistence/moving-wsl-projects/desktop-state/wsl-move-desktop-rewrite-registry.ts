/**
 * Every desktop rewrite store a committed WSL move runs, registered in run order. Startup calls it
 * once, before the first rewrite pass; the coverage test checks it against the disposition tables.
 */
import type { WslMoveBrowserCookieCopyDependencies } from './wsl-move-browser-cookie-copy'
import { registerWslMoveBrowserCookieStore } from './wsl-move-browser-cookie-store'
import { registerWslMoveRendererRewriteStores } from './wsl-move-desktop-rewrite-stores'
import {
  registerWslMoveHostAutomationsStore,
  type WslMoveHostAutomations
} from './wsl-move-host-automations-rewrite'
import {
  registerWslMoveLocalAutomationsStore,
  type WslMoveLocalAutomationsProfile
} from './wsl-move-local-automations-rewrite'
import {
  registerWslMoveMainRewriteStores,
  type WslMoveMainRewriteProfile
} from './wsl-move-main-rewrite-stores'
import { registerWslMoveOrchestrationHistoryStore } from './wsl-move-orchestration-history-rewrite'

export type WslMoveDesktopRewriteRegistryDependencies = {
  userDataPath: string
  profile: WslMoveMainRewriteProfile & WslMoveLocalAutomationsProfile
  orchestrationDatabasePath: string
  hostAutomations: WslMoveHostAutomations
  browserCookies: WslMoveBrowserCookieCopyDependencies
}

export function registerWslMoveDesktopRewriteRegistry(
  dependencies: WslMoveDesktopRewriteRegistryDependencies
): void {
  registerWslMoveMainRewriteStores(dependencies.profile)
  registerWslMoveOrchestrationHistoryStore(dependencies.orchestrationDatabasePath)
  registerWslMoveRendererRewriteStores()
  // Off here before on there: never two live copies, even for a moment.
  registerWslMoveLocalAutomationsStore(dependencies.profile, dependencies.userDataPath)
  registerWslMoveHostAutomationsStore(dependencies.hostAutomations, dependencies.userDataPath)
  // Last among main-side stores: it throws until browser sessions exist, pausing any store after it.
  registerWslMoveBrowserCookieStore(dependencies.browserCookies)
}
