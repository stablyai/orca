import type { BrowserSetAnnotationViewportBridgeArgs } from '../../shared/browser-annotation-viewport-bridge'
import type {
  BrowserClientPageMetadataParams,
  BrowserClientPageMetadataPublishOutcome
} from '../../shared/browser-client-page-metadata-protocol'
import type {
  BrowserWebAuthnAccountRequest,
  BrowserWebAuthnAccountResponse
} from '../../shared/browser-webauthn-account'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../../shared/browser-grab-types'
import type {
  BrowserContextMenuDismissedEvent,
  BrowserContextMenuRequestedEvent,
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../shared/browser-guest-events'
import type {
  BrowserCertificateFailure,
  BrowserCertificateProceedResult,
  BrowserCookieImportResult,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileCreateOptions,
  BrowserSessionProfileScope,
  BrowserSessionProfileSource,
  BrowserViewportOverride,
  BrowserViewportScrollState
} from '../../shared/browser-workspace-types'
import type {
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererRequest
} from '../../shared/browser-client-page-renderer-protocol'

export type BrowserApi = {
  /** Absent wherever this client hosts no guests of its own, which is how the web client reads. */
  readClientHostId?: () => string | null
  onClientPageRendererRequest?: (
    callback: (
      request: BrowserClientPageRendererRequest
    ) => BrowserClientPageRendererOutcome | Promise<BrowserClientPageRendererOutcome>
  ) => () => void
  registerGuest: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }) => Promise<boolean>
  isGuestRegistered: (args: { browserPageId: string; webContentsId: number }) => Promise<boolean>
  repairGuestRegistration: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }) => Promise<boolean>
  unregisterGuest: (args: { browserPageId: string }) => Promise<void>
  onWebAuthnAccountRequest: (
    callback: (request: BrowserWebAuthnAccountRequest) => void
  ) => () => void
  onWebAuthnAccountRequestClosed: (callback: (event: { requestId: string }) => void) => () => void
  respondWebAuthnAccount: (response: BrowserWebAuthnAccountResponse) => Promise<boolean>
  openDevTools: (args: { browserPageId: string }) => Promise<boolean>
  setViewportOverride: (args: {
    browserPageId: string
    override: BrowserViewportOverride | null
  }) => Promise<boolean>
  reportViewportScrollState?: (args: {
    browserPageId: string
    state: BrowserViewportScrollState
  }) => void
  setAnnotationViewportBridge: (args: BrowserSetAnnotationViewportBridgeArgs) => Promise<boolean>
  /** Publishes a client-hosted page's url/title to its runtime over that runtime's host lease. */
  publishClientPageMetadata: (args: {
    environmentId: string
    params: BrowserClientPageMetadataParams
  }) => Promise<BrowserClientPageMetadataPublishOutcome>
  onGuestLoadFailed: (
    callback: (args: { browserPageId: string; loadError: BrowserLoadError }) => void
  ) => () => void
  onCertificateFailureChanged: (
    callback: (event: { browserPageId: string; failure: BrowserCertificateFailure | null }) => void
  ) => () => void
  proceedCertificate: (args: {
    browserPageId: string
    challengeId: string
  }) => Promise<BrowserCertificateProceedResult>
  onPermissionDenied: (callback: (event: BrowserPermissionDeniedEvent) => void) => () => void
  onPopup: (callback: (event: BrowserPopupEvent) => void) => () => void
  onDownloadRequested: (callback: (event: BrowserDownloadRequestedEvent) => void) => () => void
  onDownloadProgress: (callback: (event: BrowserDownloadProgressEvent) => void) => () => void
  onDownloadFinished: (callback: (event: BrowserDownloadFinishedEvent) => void) => () => void
  onContextMenuRequested: (
    callback: (event: BrowserContextMenuRequestedEvent) => void
  ) => () => void
  onContextMenuDismissed: (
    callback: (event: BrowserContextMenuDismissedEvent) => void
  ) => () => void
  onNavigationUpdate: (
    callback: (event: { browserPageId: string; url: string; title: string }) => void
  ) => () => void
  onActivateView: (
    callback: (data: { worktreeId?: string; browserPageId?: string }) => void
  ) => () => void
  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
  ) => () => void
  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string }) => void
  ) => () => void
  cancelDownload: (args: { downloadId: string }) => Promise<boolean>
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  onGrabModeToggle: (callback: (browserPageId: string) => void) => () => void
  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ) => () => void
  sessionListProfiles: () => Promise<BrowserSessionProfile[]>
  /** Resolves once the SSH workspace's partition is bound and proxy-verified; the webview must wait for it. */
  prepareSshWorkspacePartition: (args: {
    targetId: string
    browserProfileId?: string
    skipProbe?: boolean
  }) => Promise<{ partition: string }>
  sessionCreateProfile: (
    args: {
      scope: BrowserSessionProfileScope
      label: string
    } & BrowserSessionProfileCreateOptions
  ) => Promise<BrowserSessionProfile | null>
  sessionDeleteProfile: (args: { profileId: string }) => Promise<boolean>
  sessionImportCookies: (args: { profileId: string }) => Promise<BrowserCookieImportResult>
  sessionResolvePartition: (args: { profileId: string | null }) => Promise<string | null>
  sessionDetectBrowsers: () => Promise<DetectedBrowserInfo[]>
  /** Null when the environment's pages are not client-hosted on this desktop. */
  sessionDetectBrowsersForClientHost: (args: {
    environmentId: string
  }) => Promise<DetectedBrowserInfo[] | null>
  sessionImportFromBrowser: (args: {
    profileId: string
    browserFamily: string
    browserProfile?: string
  }) => Promise<BrowserCookieImportResult>
  /** Null when the environment's pages are not client-hosted on this desktop. */
  sessionImportFromBrowserForClientHost: (args: {
    environmentId: string
    profileId: string
    browserFamily: string
    browserProfile?: string
  }) => Promise<BrowserCookieImportResult | null>
  /** Import-source badges for one environment's client-hosted jars, keyed by profile id. */
  sessionClientRouteImportSources: (args: {
    environmentId: string
  }) => Promise<Record<string, BrowserSessionProfileSource>>
  sessionClearDefaultCookies: () => Promise<boolean>
  notifyActiveTabChanged: (args: { browserPageId: string }) => Promise<boolean>
}

export type DetectedBrowserProfileInfo = {
  name: string
  directory: string
}

export type DetectedBrowserInfo = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  profiles: DetectedBrowserProfileInfo[]
  selectedProfile: string
}
