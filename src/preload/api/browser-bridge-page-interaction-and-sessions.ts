import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const browserPageInteractionAndSessionsApi = {
  onContextMenuRequested: (
    callback: (event: {
      browserPageId: string
      x: number
      y: number
      screenX: number
      screenY: number
      pageUrl: string
      linkUrl: string | null
      selectionText: string
      canGoBack: boolean
      canGoForward: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        x: number
        y: number
        screenX: number
        screenY: number
        pageUrl: string
        linkUrl: string | null
        selectionText: string
        canGoBack: boolean
        canGoForward: boolean
      }
    ) => callback(data)
    ipcRenderer.on('browser:context-menu-requested', listener)
    return () => ipcRenderer.removeListener('browser:context-menu-requested', listener)
  },
  onContextMenuDismissed: (callback: (event: { browserPageId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { browserPageId: string }) =>
      callback(data)
    ipcRenderer.on('browser:context-menu-dismissed', listener)
    return () => ipcRenderer.removeListener('browser:context-menu-dismissed', listener)
  },
  onNavigationUpdate: (
    callback: (event: { browserPageId: string; url: string; title: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; url: string; title: string }
    ) => callback(data)
    ipcRenderer.on('browser:navigation-update', listener)
    return () => ipcRenderer.removeListener('browser:navigation-update', listener)
  },
  onActivateView: (
    callback: (data: { worktreeId?: string; browserPageId?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId?: string; browserPageId?: string }
    ) => callback(data)
    ipcRenderer.on('browser:activateView', listener)
    return () => ipcRenderer.removeListener('browser:activateView', listener)
  },
  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId: string | null; browserPageId: string }
    ) => callback(data)
    ipcRenderer.on('browser:pane-focus', listener)
    return () => ipcRenderer.removeListener('browser:pane-focus', listener)
  },
  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; url: string }
    ) => callback(data)
    ipcRenderer.on('browser:open-link-in-orca-tab', listener)
    return () => ipcRenderer.removeListener('browser:open-link-in-orca-tab', listener)
  },
  cancelDownload: (args: { downloadId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:cancelDownload', args),
  setGrabMode: (args: { browserPageId: string; enabled: boolean }) =>
    ipcRenderer.invoke('browser:setGrabMode', args),
  awaitGrabSelection: (args: { browserPageId: string; opId: string }) =>
    ipcRenderer.invoke('browser:awaitGrabSelection', args),
  cancelGrab: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:cancelGrab', args),
  captureSelectionScreenshot: (args: {
    browserPageId: string
    rect: { x: number; y: number; width: number; height: number }
  }) => ipcRenderer.invoke('browser:captureSelectionScreenshot', args),
  extractHoverPayload: (args: { browserPageId: string }) =>
    ipcRenderer.invoke('browser:extractHoverPayload', args),
  onGrabModeToggle: (callback: (browserPageId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, browserPageId: string) =>
      callback(browserPageId)
    ipcRenderer.on('browser:grabModeToggle', listener)
    return () => ipcRenderer.removeListener('browser:grabModeToggle', listener)
  },
  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; key: 'c' | 's' }
    ) => callback(data)
    ipcRenderer.on('browser:grabActionShortcut', listener)
    return () => ipcRenderer.removeListener('browser:grabActionShortcut', listener)
  },
  sessionListProfiles: () => ipcRenderer.invoke('browser:session:listProfiles'),
  prepareSshWorkspacePartition: (args: {
    targetId: string
    browserProfileId?: string
    skipProbe?: boolean
  }): Promise<{ partition: string }> =>
    ipcRenderer.invoke('browser:prepareSshWorkspacePartition', args),
  sessionCreateProfile: (args: {
    scope: 'default' | 'isolated' | 'imported'
    label: string
    userAgentMode?: 'clean' | 'native'
  }) => ipcRenderer.invoke('browser:session:createProfile', args),
  sessionDeleteProfile: (args: { profileId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:session:deleteProfile', args),
  sessionImportCookies: (args: { profileId: string }) =>
    ipcRenderer.invoke('browser:session:importCookies', args),
  sessionResolvePartition: (args: { profileId: string | null }): Promise<string | null> =>
    ipcRenderer.invoke('browser:session:resolvePartition', args),
  sessionDetectBrowsers: () => ipcRenderer.invoke('browser:session:detectBrowsers'),
  sessionDetectBrowsersForClientHost: (args: { environmentId: string }) =>
    ipcRenderer.invoke('browser:session:detectBrowsersForClientHost', args),
  sessionImportFromBrowser: (args: { profileId: string; browserFamily: string }) =>
    ipcRenderer.invoke('browser:session:importFromBrowser', args),
  sessionImportFromBrowserForClientHost: (args: {
    environmentId: string
    profileId: string
    browserFamily: string
    browserProfile?: string
  }) => ipcRenderer.invoke('browser:session:importFromBrowserForClientHost', args),
  sessionClientRouteImportSources: (args: { environmentId: string }) =>
    ipcRenderer.invoke('browser:session:clientRouteImportSources', args),
  sessionClearDefaultCookies: (): Promise<boolean> =>
    ipcRenderer.invoke('browser:session:clearDefaultCookies'),
  notifyActiveTabChanged: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:activeTabChanged', args)
} satisfies Partial<PreloadApi['browser']>
