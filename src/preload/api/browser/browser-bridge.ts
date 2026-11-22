import { ipcRenderer } from 'electron'
import type { BrowserBookmarks } from '../../../shared/browser/bookmarks/browser-bookmarks'
import { browserGuestRegistrationAndDownloadsApi } from './browser-bridge-guest-registration-and-downloads'
import { browserPageInteractionAndSessionsApi } from './browser-bridge-page-interaction-and-sessions'
import { browserExtensionsApi } from './browser-bridge-extensions'
import { browserExtensionToolbarApi } from './browser-bridge-extension-toolbar'
import { browserExtensionSidePanelApi } from './browser-bridge-extension-side-panels'
import { browserExtensionWebStoreApi } from './browser-bridge-extension-webstore'
import { browserExtensionContextMenuApi } from './browser-bridge-extension-context-menu'
import { browserRemoteHostControlApi } from './browser-bridge-remote-host-control'
import type { PreloadApi } from '../../api-types'

export const browserApi = {
  bookmarks: {
    list: () => ipcRenderer.invoke('browser:bookmarks:list'),
    mutate: (scope, mutation) => ipcRenderer.invoke('browser:bookmarks:mutate', scope, mutation),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, bookmarks: BrowserBookmarks): void =>
        callback(bookmarks)
      ipcRenderer.on('browser:bookmarks:changed', listener)
      return () => ipcRenderer.removeListener('browser:bookmarks:changed', listener)
    }
  },
  ...browserGuestRegistrationAndDownloadsApi,
  ...browserPageInteractionAndSessionsApi,
  ...browserExtensionsApi,
  ...browserExtensionToolbarApi,
  ...browserExtensionSidePanelApi,
  ...browserExtensionWebStoreApi,
  ...browserExtensionContextMenuApi,
  ...browserRemoteHostControlApi
} satisfies PreloadApi['browser']
