import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type {
  MobileWebBundleCompatManifest,
  MobileWebBundleCompatVerdict,
  MobileWebBundleHostStatus
} from '../transport/mobile-web-bundle-compat'

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
}

/** What `readActiveGeneration` found, reduced to what a transition reads. */
export type CachedGeneration = {
  readonly buildId: string
  readonly directory: string
  readonly totalBytes: number
}

export type MobileWebShellBlockedVerdict = Extract<
  MobileWebBundleCompatVerdict,
  { kind: 'blocked' }
>

/** Which side a bundle read failed on. `transport` is the link between phone and host, which says
 *  nothing about the bundle; `bundle` is a verdict about it, from the host or from the bytes. */
export type MobileWebShellReadFailure = 'transport' | 'bundle'

/** The shell's own failures plus the one the view cannot report: a download or a cache write that
 *  never produced a generation to hand it. */
export type MobileWebShellFailureCause =
  | MobileWebShellFailureReason
  | 'download-failed'
  | 'status-unreadable'

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
  | { readonly kind: 'activating' }
  | {
      readonly kind: 'ready'
      readonly generationDirectory: string
      readonly sessionId: string
      readonly buildId: string
      readonly totalBytes: number
      readonly elapsedMs: number
    }
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
  /** Mint a new session id for the generation already on screen, which is what remounts the view. */
  | { readonly kind: 'remount' }

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
      readonly failure: MobileWebShellReadFailure
    }
  | { readonly type: 'shell-failed'; readonly reason: MobileWebShellFailureReason }
  | { readonly type: 'retry-pressed' }

/** Latches live beside the state because both outlive the state they were set in: `retriedOnce`
 *  spans the delete-and-refetch that puts the state back to `checking`, and `remountedOnce` spans a
 *  `ready` that is replaced by a `ready` under a new session id. */
export type MobileWebShellSession = {
  readonly state: MobileWebShellSessionState
  readonly retriedOnce: boolean
  readonly remountedOnce: boolean
  /** The gates the current step was taken on; null until the first one arrives. */
  readonly gates: MobileWebShellGates | null
  readonly cached: CachedGeneration | null
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
