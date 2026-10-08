import { browserGuestRegistrationAndDownloadsApi } from './browser-bridge-guest-registration-and-downloads'
import { browserPageInteractionAndSessionsApi } from './browser-bridge-page-interaction-and-sessions'
import type { PreloadApi } from '../api-types'
import { desktopBrowserViewApi } from './browser-bridge-desktop-view'

export const browserApi = {
  ...browserGuestRegistrationAndDownloadsApi,
  ...browserPageInteractionAndSessionsApi,
  desktopView: desktopBrowserViewApi
} satisfies PreloadApi['browser']
