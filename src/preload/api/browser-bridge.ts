import { browserGuestRegistrationAndDownloadsApi } from './browser-bridge-guest-registration-and-downloads'
import { browserPageInteractionAndSessionsApi } from './browser-bridge-page-interaction-and-sessions'
import { browserExtensionsApi } from './browser-bridge-extensions'
import { browserExtensionToolbarApi } from './browser-bridge-extension-toolbar'
import { browserExtensionWebStoreApi } from './browser-bridge-extension-webstore'
import { browserExtensionContextMenuApi } from './browser-bridge-extension-context-menu'
import type { PreloadApi } from '../api-types'

export const browserApi = {
  ...browserGuestRegistrationAndDownloadsApi,
  ...browserPageInteractionAndSessionsApi,
  ...browserExtensionsApi,
  ...browserExtensionToolbarApi,
  ...browserExtensionWebStoreApi,
  ...browserExtensionContextMenuApi
} satisfies PreloadApi['browser']
