import { registerActionNamespace } from './api/action'
import { registerCommandsNamespace } from './api/commands'
import { registerContextMenusNamespace } from './api/context-menus'
import { registerCookiesNamespace } from './api/cookies'
import { registerDeclarativeNetRequestNamespace } from './api/declarative-net-request'
import { registerDownloadsNamespace } from './api/downloads'
import { registerExtensionNamespace } from './api/extension'
import { registerManagementNamespace } from './api/management'
import { registerNativeMessagingNamespace } from './api/native-messaging'
import { registerNotificationsNamespace } from './api/notifications'
import { registerPermissionsNamespace } from './api/permissions'
import { registerPrivacyNamespace } from './api/privacy'
import { registerScriptingNamespaces } from './api/scripting'
import { registerStorageRelayNamespace } from './api/storage-relay'
import { registerStorageSyncNamespace } from './api/storage-sync'
import { registerWebRequestNamespace } from './api/web-request'
import { registerRuntimeNamespace } from './api/runtime'
import { registerTabsNamespace } from './api/tabs'
import { registerWebNavigationNamespace } from './api/web-navigation'
import { registerWindowsNamespace } from './api/windows'

/** Every main-side namespace; each must also appear in src/preload/browser-extension-api-surface.ts. */
export function registerBrowserExtensionNamespaces(): void {
  registerWindowsNamespace()
  registerTabsNamespace()
  registerWebNavigationNamespace()
  registerRuntimeNamespace()
  registerExtensionNamespace()
  registerActionNamespace()
  registerPermissionsNamespace()
  registerNotificationsNamespace()
  registerContextMenusNamespace()
  registerCommandsNamespace()
  registerPrivacyNamespace()
  registerCookiesNamespace()
  registerScriptingNamespaces()
  registerWebRequestNamespace()
  registerDownloadsNamespace()
  registerStorageRelayNamespace()
  registerStorageSyncNamespace()
  registerNativeMessagingNamespace()
  registerManagementNamespace()
  registerDeclarativeNetRequestNamespace()
}
