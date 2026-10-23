import type { BrowserSetAnnotationViewportBridgeArgs } from '../../shared/browser-annotation-viewport-bridge'
import type { ManagedBrowserProfileOwner } from '../../shared/browser-profile-scope'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../shared/browser-site-display'
import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../shared/browser-user-agent-mode'
import type {
  BrowserClientPageMetadataParams,
  BrowserClientPageMetadataPublishOutcome
} from '../../shared/browser-client-page-metadata-protocol'
import type {
  BrowserWebAuthnAccountRequest,
  BrowserWebAuthnAccountResponse
} from '../../shared/browser-webauthn-account'
import type {
  BrowserPagePromptRequest,
  BrowserPagePromptResponse,
  BrowserPagePromptResult
} from '../../shared/browser-page-prompt'
import type {
  BrowserSitePermission,
  BrowserSitePermissionDecision,
  BrowserSitePermissionEntry
} from '../../shared/browser-site-permission'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  GrabIntent
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
  /** Absent on clients that host no browser guests, including web clients. */
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
  onPagePromptRequest: (callback: (request: BrowserPagePromptRequest) => void) => () => void
  onPagePromptClosed: (callback: (event: { requestId: string }) => void) => () => void
  respondPagePrompt: (response: BrowserPagePromptResponse) => Promise<BrowserPagePromptResult>
  /** `inspectAt` (guest viewport coordinates) selects the element there. */
  openDevTools: (args: {
    browserPageId: string
    inspectAt?: { x: number; y: number }
  }) => Promise<boolean>
  addWordToDictionary: (args: { browserPageId: string; word: string }) => Promise<boolean>
  copyImageAt: (args: {
    browserPageId: string
    point: { x: number; y: number }
  }) => Promise<boolean>
  setViewportOverride: (args: {
    browserPageId: string
    override: BrowserViewportOverride | null
  }) => Promise<boolean>
  getPageSiteDisplay: (args: { browserPageId: string }) => Promise<BrowserPageSiteDisplay | null>
  /** Site zoom is scoped to the browser profile. */
  zoomPage: (args: {
    browserPageId: string
    direction: BrowserPageZoomDirection
  }) => Promise<BrowserPageSiteDisplay | null>
  /** Null makes the site match Orca's theme again. */
  setPageSiteColorScheme: (args: {
    browserPageId: string
    colorScheme: BrowserSiteColorScheme | null
  }) => Promise<BrowserPageSiteDisplay | null>
  reportViewportScrollState?: (args: {
    browserPageId: string
    state: BrowserViewportScrollState
  }) => void
  setAnnotationViewportBridge: (args: BrowserSetAnnotationViewportBridgeArgs) => Promise<boolean>
  /** Uses the owning runtime's host lease. */
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
  onCapturePaintHold: (
    callback: (data: { browserPageId: string; held: boolean }) => void
  ) => () => void
  /** Main asks the pane to keep the user's focus through an agent press; `ready` answers it. */
  onAgentInputFocusGuard: (
    callback: (data: { browserPageId: string; token: string; active: boolean }) => void
  ) => () => void
  agentInputFocusGuardReady: (token: string, composing: boolean) => void
  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
  ) => () => void
  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string; activate?: boolean }) => void
  ) => () => void
  cancelDownload: (args: { downloadId: string }) => Promise<boolean>
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  onGrabModeToggle: (callback: (browserPageId: string, intent: GrabIntent) => void) => () => void
  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ) => () => void
  sessionListProfiles: () => Promise<BrowserSessionProfile[]>
  /** Resolves once the SSH workspace's partition is bound and proxy-verified; the webview must wait for it. */
  prepareSshWorkspacePartition: (args: {
    targetId: string
    expectedSshTargetGeneration?: number
    browserProfileId?: string
    skipProbe?: boolean
  }) => Promise<{ partition: string }>
  sessionCreateProfile: (args: {
    scope: BrowserSessionProfileScope
    label: string
  }) => Promise<BrowserSessionProfile | null>
  sessionEnsureManagedProfile: (args: {
    owner: ManagedBrowserProfileOwner
    label: string
  }) => Promise<BrowserSessionProfile>
  identityGet: () => Promise<BrowserIdentityModeStatus | null>
  identitySet: (mode: BrowserUserAgentMode) => Promise<BrowserIdentityModeSetResult | null>
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
  /** Import sources keyed by browser profile ID. */
  sessionClientRouteImportSources: (args: {
    environmentId: string
  }) => Promise<Record<string, BrowserSessionProfileSource>>
  sessionClearDefaultCookies: () => Promise<boolean>
  /** Site permissions are local to this computer and browser profile. */
  sitePermissionsList: (args: { profileId: string }) => Promise<BrowserSitePermissionEntry[]>
  /** Null forgets the answer so the site is asked again. */
  sitePermissionsSet: (args: {
    profileId: string
    origin: string
    permission: BrowserSitePermission
    decision: BrowserSitePermissionDecision | null
  }) => Promise<BrowserSitePermissionEntry[]>
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
