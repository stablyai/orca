import type { GoogleCookieClearLocalTarget } from '../../shared/browser-google-cookie-clear'
import { ipcRenderer } from 'electron'
import {
  BROWSER_AGENT_ACTIVITY_CHANNEL,
  BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL,
  BROWSER_AGENT_CURSOR_CHANNEL,
  type BrowserAgentActivityEvent,
  type BrowserAgentCursorEvent
} from '../../shared/browser-agent-activity-contract'
import type { PreloadApi } from '../api-types'
import type { BrowserUserAgentMode } from '../../shared/browser-user-agent-mode'
import type { ManagedBrowserProfileOwner } from '../../shared/browser-profile-scope'
import type { GrabIntent } from '../../shared/browser-grab-types'
import type {
  BrowserSitePermission,
  BrowserSitePermissionDecision
} from '../../shared/browser-site-permission'
import type {
  BrowserContextMenuRequestedEvent,
  BrowserTargetUrlChangedEvent
} from '../../shared/browser-guest-events'

export const browserPageInteractionAndSessionsApi = {
  onContextMenuRequested: (
    callback: (event: BrowserContextMenuRequestedEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: BrowserContextMenuRequestedEvent) =>
      callback(data)
    ipcRenderer.on('browser:context-menu-requested', listener)
    return () => ipcRenderer.removeListener('browser:context-menu-requested', listener)
  },
  onContextMenuDismissed: (callback: (event: { browserPageId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { browserPageId: string }) =>
      callback(data)
    ipcRenderer.on('browser:context-menu-dismissed', listener)
    return () => ipcRenderer.removeListener('browser:context-menu-dismissed', listener)
  },
  onTargetUrlChanged: (callback: (event: BrowserTargetUrlChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: BrowserTargetUrlChangedEvent) =>
      callback(data)
    ipcRenderer.on('browser:target-url-changed', listener)
    return () => ipcRenderer.removeListener('browser:target-url-changed', listener)
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
  onCapturePaintHold: (
    callback: (data: { browserPageId: string; held: boolean }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; held: boolean }
    ) => callback(data)
    ipcRenderer.on('browser:capturePaintHold', listener)
    return () => ipcRenderer.removeListener('browser:capturePaintHold', listener)
  },
  onAgentInputFocusGuard: (
    callback: (data: { browserPageId: string; token: string; active: boolean }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; token: string; active: boolean }
    ) => callback(data)
    ipcRenderer.on('browser:agentInputFocusGuard', listener)
    return () => ipcRenderer.removeListener('browser:agentInputFocusGuard', listener)
  },
  agentInputFocusGuardReady: (token: string, composing: boolean): void => {
    ipcRenderer.send('browser:agentInputFocusGuardReady', { token, composing })
  },
  onAgentActivity: (callback: (data: BrowserAgentActivityEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: BrowserAgentActivityEvent) =>
      callback(data)
    ipcRenderer.on(BROWSER_AGENT_ACTIVITY_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BROWSER_AGENT_ACTIVITY_CHANNEL, listener)
  },
  onAgentCursor: (callback: (data: BrowserAgentCursorEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: BrowserAgentCursorEvent) =>
      callback(data)
    ipcRenderer.on(BROWSER_AGENT_CURSOR_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BROWSER_AGENT_CURSOR_CHANNEL, listener)
  },
  agentCursorArrived: (sequence: number): void => {
    ipcRenderer.send(BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL, { sequence })
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
    callback: (event: { browserPageId: string; url: string; activate?: boolean }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; url: string; activate?: boolean }
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
  onGrabModeToggle: (
    callback: (browserPageId: string, intent: GrabIntent) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      browserPageId: string,
      intent: GrabIntent
    ) => callback(browserPageId, intent)
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
  onSessionProfilesChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('browser:session:profilesChanged', listener)
    return () => ipcRenderer.removeListener('browser:session:profilesChanged', listener)
  },
  prepareSshWorkspacePartition: (args: {
    targetId: string
    expectedSshTargetGeneration?: number
    browserProfileId?: string
    skipProbe?: boolean
  }): Promise<{ partition: string }> =>
    ipcRenderer.invoke('browser:prepareSshWorkspacePartition', args),
  sessionCreateProfile: (args: { scope: 'default' | 'isolated' | 'imported'; label: string }) =>
    ipcRenderer.invoke('browser:session:createProfile', args),
  sessionEnsureManagedProfile: (args: { owner: ManagedBrowserProfileOwner; label: string }) =>
    ipcRenderer.invoke('browser:session:ensureManagedProfile', args),
  identityGet: () => ipcRenderer.invoke('browser:identity:get'),
  identitySet: (mode: BrowserUserAgentMode) => ipcRenderer.invoke('browser:identity:set', mode),
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
  sessionGoogleCookieClearTarget: (args: { profileId: string; environmentId: string | null }) =>
    ipcRenderer.invoke('browser:session:googleCookieClearTarget', args),
  sessionClearGoogleCookies: (target: GoogleCookieClearLocalTarget) =>
    ipcRenderer.invoke('browser:session:clearGoogleCookies', target),
  sessionClearDefaultCookies: (): Promise<boolean> =>
    ipcRenderer.invoke('browser:session:clearDefaultCookies'),
  sitePermissionsList: (args: { profileId: string }) =>
    ipcRenderer.invoke('browser:sitePermissions:list', args),
  sitePermissionsSet: (args: {
    profileId: string
    origin: string
    permission: BrowserSitePermission
    decision: BrowserSitePermissionDecision | null
  }) => ipcRenderer.invoke('browser:sitePermissions:set', args),
  notifyActiveTabChanged: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:activeTabChanged', args)
} satisfies Partial<PreloadApi['browser']>
