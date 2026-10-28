import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type { MobileWebPageRoute, PageRouteRefusalVerdict } from './page-route-policy'
import type {
  MobileWebBundleCompatManifest,
  MobileWebBundleCompatVerdict,
  MobileWebBundleHostStatus
} from '../transport/mobile-web-bundle-compat'
import type {
  MobileWebShellUpdateFailureCause,
  MobileWebShellUpdateFailureFacts
} from './mobile-web-shell-update-failure'

// Wait for connecting so cache cannot flash before the host’s compatibility check; only settled unreachability opens it unchecked.
export type MobileWebShellReachability = 'connected' | 'connecting' | 'unreachable'

export type MobileWebShellGates = {
  readonly statusPending: boolean
  // Unreadable includes absent/undecodable replies; their empty capabilities must not masquerade as bundle-unavailable.
  readonly statusReadable: boolean
  readonly reachability: MobileWebShellReachability
  readonly hostCapabilities: readonly string[]
  readonly hostStatus: MobileWebBundleHostStatus
}

export type MobileWebShellManifestFacts = MobileWebBundleCompatManifest & {
  readonly buildId: string
  readonly totalBytes: number
  readonly totalAssets: number
  // Older desktops omit routes and serve none.
  readonly routes: readonly MobileWebPageRoute[] | undefined
}

export type CachedGeneration = {
  readonly buildId: string
  readonly directory: string
  readonly totalBytes: number
  readonly routes: readonly MobileWebPageRoute[] | undefined
  // Use the persisted bytes’ required compat fields when a reachable host judges cache; invalid manifests never become CachedGeneration.
  readonly compat: MobileWebBundleCompatManifest
}

export type MobileWebShellBlockedVerdict =
  | Extract<MobileWebBundleCompatVerdict, { kind: 'blocked' }>
  | PageRouteRefusalVerdict

export type MobileWebShellFailureCause =
  | MobileWebShellFailureReason
  | 'download-failed'
  | 'status-unreadable'

// Show a transient notice beside a running fallback after manifest/asset refusal; neither failure proves newer bytes exist. Reentering the flow asks again.
export type MobileWebShellUpdateNotice = 'update-failed'

export type MobileWebShellSessionState =
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'fetching'
      readonly completedAssets: number
      readonly totalAssets: number
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  // Only download activation counts as a landed update; opening cache does not.
  | { readonly kind: 'activating'; readonly source: 'download' | 'cache' }
  | {
      readonly kind: 'ready'
      readonly generationDirectory: string
      readonly sessionId: string
      readonly buildId: string
      readonly totalBytes: number
      readonly elapsedMs: number
    }
  // Neither app can be blamed when the path is unknown locally or its manifest pattern is unreadable.
  | { readonly kind: 'route-unavailable' }
  | { readonly kind: 'wall'; readonly verdict: MobileWebShellBlockedVerdict }
  | {
      readonly kind: 'failed'
      readonly reason: MobileWebShellFailureCause
      readonly retriedOnce: boolean
    }
  | { readonly kind: 'offline' }

export type MobileWebShellSessionEffect =
  | { readonly kind: 'open-cache' }
  | { readonly kind: 'read-manifest' }
  | { readonly kind: 'download' }
  | {
      readonly kind: 'open-generation'
      readonly directory: string
      readonly buildId: string
      readonly totalBytes: number
    }
  | { readonly kind: 'delete-cache' }
  | { readonly kind: 'remount' }
  // Stamp expiry with its flow; the reducer ignores it once ready arrives, so the runner owns timing without deciding recovery.
  | { readonly kind: 'await-page-ready' }
  // A refused/uncommitted local load may report nothing; only the deadline can end it.
  | { readonly kind: 'await-document-load' }
  // Persist on-device evidence for Troubleshoot because release builds forward no console output.
  | { readonly kind: 'record-update-failure'; readonly failure: MobileWebShellUpdateFailureFacts }
  | { readonly kind: 'forget-update-failures' }

// Drop effect results from superseded flows so late failures cannot replace a running workspace. View events apply only to the mounted generation; gates/retry arrive outside the flow.
export type MobileWebShellSessionEvent =
  | { readonly type: 'gates-changed'; readonly gates: MobileWebShellGates }
  | {
      readonly type: 'cache-read'
      readonly flow: number
      readonly generation: CachedGeneration | null
    }
  | {
      readonly type: 'manifest-read'
      readonly flow: number
      readonly manifest: MobileWebShellManifestFacts
    }
  | {
      readonly type: 'fetch-progress'
      readonly flow: number
      readonly completedAssets: number
      readonly totalAssets: number
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | { readonly type: 'download-staged'; readonly flow: number }
  | {
      readonly type: 'activated'
      readonly flow: number
      readonly generationDirectory: string
      readonly sessionId: string
      readonly buildId: string
      readonly totalBytes: number
      readonly elapsedMs: number
    }
  | { readonly type: 'remounted'; readonly flow: number; readonly sessionId: string }
  | {
      readonly type: 'download-failed'
      readonly flow: number
      readonly cause: MobileWebShellUpdateFailureCause
    }
  | { readonly type: 'shell-failed'; readonly reason: MobileWebShellFailureReason }
  | { readonly type: 'retry-pressed' }
  | { readonly type: 'document-started' }
  | { readonly type: 'document-loaded' }
  // Ready proves page code ran, not that a tree painted.
  | { readonly type: 'page-ready' }
  | { readonly type: 'page-painted' }
  // Document resets explicitly clear Back claims; never infer relinquishment from silence.
  | { readonly type: 'page-back-claim'; readonly claimed: boolean }
  | { readonly type: 'page-ready-deadline'; readonly flow: number }
  | { readonly type: 'document-load-deadline'; readonly flow: number }
  | { readonly type: 'layout-changed'; readonly wide: boolean }
  // Wall-clock read deadlines can fail a download while the app is away with the link still up.
  | { readonly type: 'app-foregrounded' }

// Keep retry/remount latches outside state because they must survive checking/ready replacements.
export type MobileWebShellSession = {
  readonly routePathname: string
  // Unknown catch-all routes cannot prove the desktop is outdated.
  readonly appNamesRoute: boolean
  // Wide serving requires canOwnHostArea; the owning host route combines served routes’ grants.
  readonly wide: boolean
  readonly routes: readonly MobileWebPageRoute[] | undefined
  readonly ownsHostArea: boolean
  readonly pageRoutes: readonly string[]
  // Carry each route’s declared grants so local hops can be checked against the current session’s authority.
  readonly pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  // Init uses this route’s effective grants, or the combined grants when it owns the host area.
  readonly routeGrants: readonly string[]
  readonly state: MobileWebShellSessionState
  readonly retriedOnce: boolean
  readonly remountedOnce: boolean
  // Set by a download the link cut off; the next reachable gates restart the flow, resuming from kept files.
  readonly retryOnReconnect: boolean
  // Reset document facts on every new document; the previous page’s ready cannot prove this one ran.
  readonly pageReady: boolean
  readonly pagePainted: boolean
  readonly documentLoaded: boolean
  // Clear with document state so stale sheets cannot retain Back claims.
  readonly pageBackClaimed: boolean
  readonly gates: MobileWebShellGates | null
  readonly cached: CachedGeneration | null
  // Clear on flow entry so the notice cannot outlive the fallback it explains.
  readonly updateNotice: MobileWebShellUpdateNotice | null
  readonly requestedBuildId: string | null
  // Stamp effects/results with the incremented flow to reject superseded work.
  readonly flow: number
}

// Stamp every effect with the resulting session.flow so its completion can be matched.
export type MobileWebShellStep = {
  readonly session: MobileWebShellSession
  readonly effects: readonly MobileWebShellSessionEffect[]
}
