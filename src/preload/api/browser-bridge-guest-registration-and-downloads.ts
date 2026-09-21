import { ipcRenderer } from 'electron'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import type {
  BrowserWebAuthnAccountRequest,
  BrowserWebAuthnAccountResponse
} from '../../shared/browser-webauthn-account'
import { readBrowserClientHostIdArgument } from '../../shared/browser-client-host-id-argument'
import { browserClientPageRendererRequests } from '../preload-runtime-support'
import type { PreloadApi } from '../api-types'

export const browserGuestRegistrationAndDownloadsApi = {
  onClientPageRendererRequest: browserClientPageRendererRequests.subscribe,
  readClientHostId: (): string | null => readBrowserClientHostIdArgument(process.argv),
  registerGuest: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }): Promise<boolean> => ipcRenderer.invoke('browser:registerGuest', args),
  isGuestRegistered: (args: { browserPageId: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke('browser:isGuestRegistered', args),
  repairGuestRegistration: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }): Promise<boolean> => ipcRenderer.invoke('browser:repairGuestRegistration', args),
  unregisterGuest: (args: { browserPageId: string }): Promise<void> =>
    ipcRenderer.invoke('browser:unregisterGuest', args),
  onWebAuthnAccountRequest: (
    callback: (request: BrowserWebAuthnAccountRequest) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: BrowserWebAuthnAccountRequest
    ): void => callback(request)
    ipcRenderer.on('browser:webauthn-account-requested', listener)
    return () => ipcRenderer.removeListener('browser:webauthn-account-requested', listener)
  },
  onWebAuthnAccountRequestClosed: (
    callback: (event: { requestId: string }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }): void =>
      callback(data)
    ipcRenderer.on('browser:webauthn-account-request-closed', listener)
    return () => ipcRenderer.removeListener('browser:webauthn-account-request-closed', listener)
  },
  respondWebAuthnAccount: (response: BrowserWebAuthnAccountResponse): Promise<boolean> =>
    ipcRenderer.invoke('browser:respondWebAuthnAccount', response),
  openDevTools: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:openDevTools', args),
  setViewportOverride: (args: {
    browserPageId: string
    override: BrowserViewportOverride | null
  }): Promise<boolean> => ipcRenderer.invoke('browser:setViewportOverride', args),
  reportViewportScrollState: (args: {
    browserPageId: string
    state: {
      scrollLeft: number
      scrollTop: number
      maxScrollLeft: number
      maxScrollTop: number
    }
  }): void => ipcRenderer.send('browser:reportViewportScrollState', args),
  setAnnotationViewportBridge: (args): Promise<boolean> =>
    ipcRenderer.invoke('browser:setAnnotationViewportBridge', args),
  publishClientPageMetadata: (args) =>
    ipcRenderer.invoke('browser:publishClientPageMetadata', args),
  onGuestLoadFailed: (
    callback: (args: {
      browserPageId: string
      loadError: { code: number; description: string; validatedUrl: string }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        loadError: { code: number; description: string; validatedUrl: string }
      }
    ) => callback(data)
    ipcRenderer.on('browser:guest-load-failed', listener)
    return () => ipcRenderer.removeListener('browser:guest-load-failed', listener)
  },
  onCertificateFailureChanged: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => callback(data)
    ipcRenderer.on('browser:certificate-failure-changed', listener)
    return () => ipcRenderer.removeListener('browser:certificate-failure-changed', listener)
  },
  proceedCertificate: (args) => ipcRenderer.invoke('browser:proceedCertificate', args),
  onPermissionDenied: (
    callback: (event: { browserPageId: string; permission: string; origin: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; permission: string; origin: string }
    ) => callback(data)
    ipcRenderer.on('browser:permission-denied', listener)
    return () => ipcRenderer.removeListener('browser:permission-denied', listener)
  },
  onPopup: (
    callback: (event: {
      browserPageId: string
      origin: string
      action: 'opened-in-orca' | 'opened-external' | 'blocked'
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        origin: string
        action: 'opened-in-orca' | 'opened-external' | 'blocked'
      }
    ) => callback(data)
    ipcRenderer.on('browser:popup', listener)
    return () => ipcRenderer.removeListener('browser:popup', listener)
  },
  onDownloadRequested: (
    callback: (event: {
      browserPageId: string
      downloadId: string
      origin: string
      filename: string
      totalBytes: number | null
      mimeType: string | null
      savePath: string
      status: 'downloading'
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        downloadId: string
        origin: string
        filename: string
        totalBytes: number | null
        mimeType: string | null
        savePath: string
        status: 'downloading'
      }
    ) => callback(data)
    ipcRenderer.on('browser:download-requested', listener)
    return () => ipcRenderer.removeListener('browser:download-requested', listener)
  },
  onDownloadProgress: (
    callback: (event: {
      browserPageId?: string
      downloadId: string
      receivedBytes: number
      totalBytes: number | null
      state: 'progressing' | 'interrupted' | null
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId?: string
        downloadId: string
        receivedBytes: number
        totalBytes: number | null
        state: 'progressing' | 'interrupted' | null
      }
    ) => callback(data)
    ipcRenderer.on('browser:download-progress', listener)
    return () => ipcRenderer.removeListener('browser:download-progress', listener)
  },
  onDownloadFinished: (
    callback: (event: {
      browserPageId?: string
      downloadId: string
      status: 'completed' | 'canceled' | 'failed'
      savePath: string | null
      remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
      error: string | null
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId?: string
        downloadId: string
        status: 'completed' | 'canceled' | 'failed'
        savePath: string | null
        remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
        error: string | null
      }
    ) => callback(data)
    ipcRenderer.on('browser:download-finished', listener)
    return () => ipcRenderer.removeListener('browser:download-finished', listener)
  }
} satisfies Partial<PreloadApi['browser']>
