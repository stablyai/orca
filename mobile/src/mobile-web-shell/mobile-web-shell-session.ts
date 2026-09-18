import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  evaluateMobileWebBundleCompat,
  type MobileWebBundleCompatManifest,
  type MobileWebBundleCompatVerdict,
  type MobileWebBundleHostStatus
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

/**
 * The host's connection state as the three answers a step here needs.
 *
 * `reconnecting` is unreachable, not connecting, and that is the whole point of the distinction: a
 * host whose desktop is gone never settles on `disconnected`. The client dials, fails, schedules a
 * retry and cycles `connecting` -> `reconnecting` -> `connecting` with the delay growing to a
 * minute, so treating `reconnecting` as "still dialling" leaves a phone with a perfectly good
 * cached workspace spinning forever. `connecting` alone is the first dial, which is worth the wait
 * because it usually succeeds; a scheduled retry after a failure is evidence the host is not there.
 */
export function readMobileWebShellReachability(
  connState: ConnectionState,
  client: RpcClient | null
): MobileWebShellReachability {
  if (connState === 'connected') {
    return client === null ? 'connecting' : 'connected'
  }
  return connState === 'connecting' || connState === 'handshaking' ? 'connecting' : 'unreachable'
}

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

/** The shell's own failures plus the one the view cannot report: a download or a cache write that
 *  never produced a generation to hand it. */
export type MobileWebShellFailureCause = MobileWebShellFailureReason | 'download-failed'

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

export type MobileWebShellSessionEvent =
  | { readonly type: 'gates-changed'; readonly gates: MobileWebShellGates }
  | { readonly type: 'cache-read'; readonly generation: CachedGeneration | null }
  | { readonly type: 'manifest-read'; readonly manifest: MobileWebShellManifestFacts }
  | {
      readonly type: 'fetch-progress'
      readonly completedAssets: number
      readonly totalAssets: number
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | { readonly type: 'download-staged' }
  | {
      readonly type: 'activated'
      readonly generationDirectory: string
      readonly sessionId: string
      readonly buildId: string
      readonly totalBytes: number
      readonly elapsedMs: number
    }
  | { readonly type: 'remounted'; readonly sessionId: string }
  | { readonly type: 'download-failed' }
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
}

export type MobileWebShellStep = {
  readonly session: MobileWebShellSession
  readonly effects: readonly MobileWebShellSessionEffect[]
}

const CHECKING: MobileWebShellSessionState = { kind: 'checking' }

export function createMobileWebShellSession(): MobileWebShellSession {
  return { state: CHECKING, retriedOnce: false, remountedOnce: false, gates: null, cached: null }
}

function step(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession>,
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  return { session: { ...session, ...patch }, effects }
}

/**
 * Whether a gates change may start or restart the flow.
 *
 * Only from the two states still waiting on one. A displayed generation is not restarted by a
 * reconnect: the manifest check that would follow swaps the page out from under whoever is reading
 * it, and a cached generation stays valid until the route is entered again. A wall and a terminal
 * failure are both left by acting, so neither reacts either.
 */
function awaitsGates(state: MobileWebShellSessionState): boolean {
  return state.kind === 'checking' || state.kind === 'offline'
}

/** The first step of the flow, and the one "Try again" returns to. */
function startFlow(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  patch: Partial<MobileWebShellSession> = {}
): MobileWebShellStep {
  const base = { ...patch, gates, remountedOnce: false }
  if (gates.reachability === 'connecting') {
    return step(session, { ...base, state: CHECKING })
  }
  if (gates.reachability === 'unreachable') {
    // Offline still sweeps and still reads the cache: an unreachable host is the one case where a
    // generation opens with no compat check at all.
    return step(session, { ...base, state: CHECKING }, [{ kind: 'open-cache' }])
  }
  // Never on an unreadable status: the empty capability list it leaves behind is indistinguishable
  // from a desktop that ships no bundle, and that wall has no way out but updating the desktop.
  if (gates.statusPending || !gates.statusReadable) {
    return step(session, { ...base, state: CHECKING })
  }
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest: null
  })
  if (verdict.kind === 'blocked') {
    return step(session, { ...base, state: { kind: 'wall', verdict } })
  }
  return step(session, { ...base, state: CHECKING }, [{ kind: 'open-cache' }])
}

function onCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null
): MobileWebShellStep {
  const gates = session.gates
  if (gates === null) {
    return step(session, { cached: generation })
  }
  if (gates.reachability !== 'connected') {
    // No compat check on this path, by design: the generation was compatible when it was cached and
    // a host nobody can reach cannot have changed since. The next entry while connected re-checks.
    return generation === null
      ? step(session, { cached: null, state: { kind: 'offline' } })
      : step(session, { cached: generation, state: { kind: 'activating' } }, [
          {
            kind: 'open-generation',
            directory: generation.directory,
            buildId: generation.buildId,
            totalBytes: generation.totalBytes
          }
        ])
  }
  return step(session, { cached: generation, state: CHECKING }, [{ kind: 'read-manifest' }])
}

function onManifestRead(
  session: MobileWebShellSession,
  manifest: MobileWebShellManifestFacts
): MobileWebShellStep {
  const gates = session.gates
  if (gates === null) {
    return step(session, {})
  }
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest
  })
  if (verdict.kind === 'blocked') {
    return step(session, { state: { kind: 'wall', verdict } })
  }
  const cached = session.cached
  if (cached !== null && cached.buildId === manifest.buildId) {
    return step(session, { state: { kind: 'activating' } }, [
      {
        kind: 'open-generation',
        directory: cached.directory,
        buildId: cached.buildId,
        totalBytes: cached.totalBytes
      }
    ])
  }
  return step(
    session,
    {
      state: {
        kind: 'fetching',
        completedAssets: 0,
        totalAssets: manifest.totalAssets,
        receivedBytes: 0,
        totalBytes: manifest.totalBytes
      }
    },
    [{ kind: 'download' }]
  )
}

/**
 * B3's contract, and the only place it is interpreted.
 *
 * `generation-unreadable` and `document-load-failed` say the bytes on disk are suspect, so the
 * host's cache goes and the flow runs once more. `render-process-gone` says nothing about the
 * bytes — renderer memory pressure and a WebView provider update look identical from here — so it
 * remounts and never deletes. `isolation-unavailable` is terminal on the first report: the fence is
 * the whole reason this view exists, and a device that cannot install it will not on a retry.
 */
function onShellFailed(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason
): MobileWebShellStep {
  const failed = { kind: 'failed', reason, retriedOnce: session.retriedOnce } as const
  if (reason === 'isolation-unavailable') {
    return step(session, { state: failed })
  }
  if (reason === 'render-process-gone') {
    return session.remountedOnce || session.state.kind !== 'ready'
      ? step(session, { state: failed })
      : step(session, { remountedOnce: true }, [{ kind: 'remount' }])
  }
  if (session.retriedOnce || session.gates === null) {
    return step(session, { state: failed })
  }
  return step(session, { retriedOnce: true, cached: null, state: CHECKING }, [
    { kind: 'delete-cache' },
    { kind: 'open-cache' }
  ])
}

/**
 * One transition of the hybrid shell session: a state and the effects the runner owes it.
 *
 * Pure, so every rule above is a table test rather than a simulator run. The runner may drop an
 * effect's result (an unmount, a host change) but must never invent one.
 */
export function reduceMobileWebShellSession(
  session: MobileWebShellSession,
  event: MobileWebShellSessionEvent
): MobileWebShellStep {
  switch (event.type) {
    case 'gates-changed':
      return awaitsGates(session.state)
        ? startFlow(session, event.gates)
        : step(session, { gates: event.gates })
    case 'cache-read':
      return onCacheRead(session, event.generation)
    case 'manifest-read':
      return onManifestRead(session, event.manifest)
    case 'fetch-progress':
      return session.state.kind === 'fetching'
        ? step(session, {
            state: {
              kind: 'fetching',
              completedAssets: event.completedAssets,
              totalAssets: event.totalAssets,
              receivedBytes: event.receivedBytes,
              totalBytes: event.totalBytes
            }
          })
        : step(session, {})
    case 'download-staged':
      return session.state.kind === 'fetching'
        ? step(session, { state: { kind: 'activating' } })
        : step(session, {})
    case 'activated':
      return step(session, {
        state: {
          kind: 'ready',
          generationDirectory: event.generationDirectory,
          sessionId: event.sessionId,
          buildId: event.buildId,
          totalBytes: event.totalBytes,
          elapsedMs: event.elapsedMs
        }
      })
    case 'remounted':
      // Only the session id changes, so the view remounts against the same verified bytes.
      return session.state.kind === 'ready'
        ? step(session, { state: { ...session.state, sessionId: event.sessionId } })
        : step(session, {})
    case 'download-failed':
      return step(session, {
        state: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce }
      })
    case 'shell-failed':
      return onShellFailed(session, event.reason)
    case 'retry-pressed':
      // Clears both latches, so the delete-and-refetch and the remount are each available again.
      return session.gates === null
        ? step(session, { retriedOnce: false, remountedOnce: false, state: CHECKING })
        : startFlow(session, session.gates, { retriedOnce: false, cached: null })
  }
}
