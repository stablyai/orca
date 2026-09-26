import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { MobileWebPageRoute } from './page-route-policy'
import type {
  MobileWebBundleCompatManifest,
  MobileWebBundleCompatVerdict,
  MobileWebBundleHostStatus
} from '../transport/mobile-web-bundle-compat'
import type {
  MobileWebShellUpdateFailureCause,
  MobileWebShellUpdateFailureFacts
} from './mobile-web-shell-update-failure'

/** What one `ready` declared: what the page will report, and what it can be sent. */
export type PageReadyDeclaration = {
  readonly reports: readonly string[]
  readonly accepts: readonly string[]
}
/**
 * Whether the host can be asked anything right now.
 *
 * Three values, not a boolean: a connection still being made is not an offline host, and opening a
 * cached generation with no compat check for the second or two before a socket completes would
 * flash a workspace this host may already have replaced. `connecting` waits; only a settled
 * non-connection opens the cache unchecked.
 */
export type MobileWebShellReachability = 'connected' | 'connecting' | 'unreachable'

/** Everything the gates say that decides a step here, as one value so a transition is a pure
 *  function of it rather than of four separately-arriving props. */
export type MobileWebShellGates = {
  readonly statusPending: boolean
  /** False for a status nobody answered *and* for one this client could not decode. Both leave the
   *  capability list empty, which would otherwise read as `bundle-unavailable` and wall a host that
   *  simply did not reply. */
  readonly statusReadable: boolean
  readonly reachability: MobileWebShellReachability
  readonly hostCapabilities: readonly string[]
  readonly hostStatus: MobileWebBundleHostStatus
}

/** The manifest fields a transition reads: the wall's three, plus what names and sizes the
 *  generation the cache is compared against. */
export type MobileWebShellManifestFacts = MobileWebBundleCompatManifest & {
  readonly buildId: string
  readonly totalBytes: number
  readonly totalAssets: number
  /** Undefined for a desktop older than the field, which is every route staying native. */
  readonly routes: readonly MobileWebPageRoute[] | undefined
  /** The manifest as it arrived, which is what a same-build hit writes beside the cached assets.
   *  Carried whole rather than rebuilt from the fields above: the store compares its asset list
   *  against the stored one, and a re-serialised projection would drop both what this client reads
   *  loosely and what a newer desktop added. */
  readonly wire: MobileWebBundleManifestRead
}

/** What `readActiveGeneration` found, reduced to what a transition reads. */
export type CachedGeneration = {
  readonly buildId: string
  readonly directory: string
  readonly totalBytes: number
  /** The routes the cached bundle declared, which is what an unreachable host is judged by. */
  readonly routes: readonly MobileWebPageRoute[] | undefined
  /** What these bytes declare, read off the manifest stored beside them, so a generation served
   *  while the host is reachable can be judged against it. Never absent: `readActiveGeneration`
   *  answers null for a generation whose manifest did not parse, and the schema requires all
   *  three. */
  readonly compat: MobileWebBundleCompatManifest
}

export type MobileWebShellBlockedVerdict = Extract<
  MobileWebBundleCompatVerdict,
  { kind: 'blocked' }
>

/** The shell's own failures plus the one the view cannot report: a download or a cache write that
 *  never produced a generation to hand it. */
export type MobileWebShellFailureCause =
  | MobileWebShellFailureReason
  | 'download-failed'
  | 'status-unreadable'

/**
 * Why the workspace on screen is not the one this host serves now.
 *
 * Set when the shell asked a reachable host for an update and refused the answer — a manifest it
 * could not read, or assets that did not arrive whole — and opened the last generation it had
 * accepted instead. A notice beside `ready`, never a state in front of it: the page is running and
 * nothing about it is blocked.
 *
 * Named rather than a flag, and one name rather than two, because one name is all that is verified
 * from here: both refusals arrive as the same event, and neither proves a newer generation exists.
 * Nothing about it is persisted, so the next flow asks again.
 */
export type MobileWebShellUpdateNotice = 'update-failed'

export type MobileWebShellSessionState =
  /** Gates unsettled, cache being read, or a manifest in flight. Nothing is on screen yet. */
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'fetching'
      readonly completedAssets: number
      readonly totalAssets: number
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  /** Bytes are in; the store is staging and committing, or a cache hit is being opened. */
  /** `download` is a generation this flow fetched and is committing; `cache` is one already on
   *  disk. Only a download's activation is an update that landed. */
  | { readonly kind: 'activating'; readonly source: 'download' | 'cache' }
  | {
      readonly kind: 'ready'
      readonly generationDirectory: string
      readonly sessionId: string
      readonly buildId: string
      readonly totalBytes: number
      readonly elapsedMs: number
    }
  /**
   * This route is the native screen's, and the caller renders it.
   *
   * Either the bundle does not list the route, or it lists it needing a grant this shell does not
   * implement, or the desktop ships no bundle at all. Not a failure and not a wall: every route
   * starts native, and the negotiation saying no leaves it where it was.
   */
  | { readonly kind: 'native-route' }
  | { readonly kind: 'wall'; readonly verdict: MobileWebShellBlockedVerdict }
  | {
      readonly kind: 'failed'
      readonly reason: MobileWebShellFailureCause
      readonly retriedOnce: boolean
    }
  | { readonly kind: 'offline' }

export type MobileWebShellSessionEffect =
  /** Sweep every host's staging tree, then read this host's activation. Lazy on purpose: with the
   *  flag off nothing in the app reaches this, so nothing sweeps at launch. */
  | { readonly kind: 'open-cache' }
  | { readonly kind: 'read-manifest' }
  /** Fetch, stage, commit. The runner reports progress, then `download-staged`, then `activated`. */
  | { readonly kind: 'download' }
  /** A cache hit: nothing to download, so this only mints a session id and reports the activation. */
  | {
      readonly kind: 'open-generation'
      readonly directory: string
      readonly buildId: string
      readonly totalBytes: number
    }
  | { readonly kind: 'delete-cache' }
  /** Rewrite the manifest stored beside the generation just opened. Only a same-build hit asks for
   *  it: the assets are the ones the manifest names, and the routes are an edit newer. Nothing is
   *  reported back, because the fresh routes are already on the session. */
  | { readonly kind: 'persist-manifest'; readonly manifest: MobileWebBundleManifestRead }
  /** Mint a new session id for the generation already on screen, which is what remounts the view. */
  | { readonly kind: 'remount' }
  /** Start the clock on the page's first word. Expiry arrives as `page-ready-deadline` for the flow
   *  it was armed in, and nothing cancels it: a `ready` that lands first makes the expiry a no-op,
   *  so the runner owns a timer and none of the decision. */
  | { readonly kind: 'await-page-ready' }
  /** Write down why an update read failed, on the device, for Troubleshoot to show: a release
   *  build forwards no console output, so without it the banner is the only evidence. */
  | { readonly kind: 'record-update-failure'; readonly failure: MobileWebShellUpdateFailureFacts }
  /** Clear this host's recorded failures: a newer generation committed, so "last update failed"
   *  would no longer be true. */
  | { readonly kind: 'forget-update-failures' }

/**
 * Events, in two kinds.
 *
 * The seven that carry a `flow` are results reported out of an effect, and the number is the flow
 * the step that asked for them was in. Anything a superseded flow reports is dropped: a manifest
 * read that was in flight when the socket dropped still rejects afterwards, and applying that
 * rejection would replace a workspace already on screen with a download failure. The other three
 * come from outside the flow: the gates and the retry button always apply, and the view's failure
 * applies only while its generation is the one on screen, which is the only state that mounted it.
 */
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
  /** The native view began a document. Unstamped, like the view's failure and for the same
   *  reason: the view exists only under the generation on screen. */
  | { readonly type: 'document-started' }
  /** The native view finished a document. Unstamped, like the view's failure and for the same
   *  reason: the view exists only under the generation on screen. */
  | { readonly type: 'document-loaded' }
  /**
   * The page said `ready` over the bridge, which is the only proof its code ran at all, carrying
   * what that `ready` declared it reports and accepts.
   */
  | ({ readonly type: 'page-ready' } & PageReadyDeclaration)
  /** The page has a frame on screen. Only a page that declared it ever sends one. */
  | { readonly type: 'page-painted' }
  /** The page is holding the device Back key, or has let it go. The host sends false on its own
   *  for every way a document ends, so this never has to be inferred from silence. */
  | { readonly type: 'page-back-claim'; readonly claimed: boolean }
  | { readonly type: 'page-ready-deadline'; readonly flow: number }

/** Latches live beside the state because both outlive the state they were set in: `retriedOnce`
 *  spans the delete-and-refetch that puts the state back to `checking`, and `remountedOnce` spans a
 *  `ready` that is replaced by a `ready` under a new session id. */
export type MobileWebShellSession = {
  /** The concrete route this session was opened for, matched against what the bundle lists. */
  readonly routePathname: string
  /** Every route pattern this shell would render from the page, as the bundle in hand declares
   *  them. The page is told, so it keeps a navigation into one of them instead of handing it back. */
  readonly pageRoutes: readonly string[]
  /** The same routes with what each declared, which is what lets the page tell a hop it may keep
   *  from one that would run under the wrong grants. */
  readonly pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  /** What the route this mount stands for declared, narrowed to what this shell implements. It is
   *  what `init` grants, so a route that asked for less is served less. */
  readonly routeGrants: readonly string[]
  readonly state: MobileWebShellSessionState
  readonly retriedOnce: boolean
  readonly remountedOnce: boolean
  /** Whether the document on screen has spoken over the bridge. Cleared by every new document,
   *  because each one has to prove itself: the last one's word says nothing about this one. */
  readonly pageReady: boolean
  /** Whether this document said it would report its first paint. Cleared with `pageReady`, and
   *  false for every page built before the report existed. */
  readonly pageReportsPaint: boolean
  /** Whether this document has reported a frame on screen. Cleared with `pageReady`. */
  readonly pagePainted: boolean
  /**
   * Whether the document on screen is holding the device Back key.
   *
   * Cleared with the rest of what a document says about itself, and that is the load-bearing half:
   * a claim that outlived its sheet would have the shell hand Back to a page with nothing to do
   * with it, which is a key that does nothing at all.
   */
  readonly pageBackClaimed: boolean
  /** Whether this document pads for the system bars itself, so the view may go edge-to-edge.
   *  Cleared with `pageReady`, and false for every page built before the declaration existed. */
  readonly pageOwnsSafeArea: boolean
  /** Whether this document reads the keyboard height from `init`, so the keyboard may cover the
   *  view. Cleared with `pageReady`, and false for every page built before the declaration. */
  readonly pageReadsKeyboardInset: boolean
  /** The gates the current step was taken on; null until the first one arrives. */
  readonly gates: MobileWebShellGates | null
  readonly cached: CachedGeneration | null
  /** Null unless the generation on screen is a fallback from an update this shell refused. Cleared
   *  by every entry into the flow, so it never outlives the screen it explains. */
  readonly updateNotice: MobileWebShellUpdateNotice | null
  /** The generation this flow asked the host for, so a failed read can name it. Cleared by every
   *  entry into the flow. */
  readonly requestedBuildId: string | null
  /** Which run of the flow the session is on. Bumped by every restart, stamped on the effects that
   *  run belongs to, and echoed back on their results. */
  readonly flow: number
}

/** A transition: the session it produced and the effects it owes. Every effect belongs to
 *  `session.flow`, which is what the runner echoes back on the result. */
export type MobileWebShellStep = {
  readonly session: MobileWebShellSession
  readonly effects: readonly MobileWebShellSessionEffect[]
}
