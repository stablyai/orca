import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { evaluateMobileWebBundleCompat } from '../transport/mobile-web-bundle-compat'
import type {
  CachedGeneration,
  MobileWebShellBlockedVerdict,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellReachability,
  MobileWebShellReadFailure,
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'

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

const CHECKING: MobileWebShellSessionState = { kind: 'checking' }

export function createMobileWebShellSession(): MobileWebShellSession {
  return {
    state: CHECKING,
    retriedOnce: false,
    remountedOnce: false,
    gates: null,
    cached: null,
    flow: 0
  }
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
  if (state.kind === 'failed') {
    // The one failure the gates can answer: a status that becomes readable is a different host
    // screen, and it costs nothing to take it rather than make someone walk back out.
    return state.reason === 'status-unreadable'
  }
  return state.kind === 'checking' || state.kind === 'offline'
}

/**
 * What the gates permit, before any manifest is read.
 *
 * One answer for both ways into the flow. A recovery used to keep whatever gates the `ready`
 * session was holding and go straight back to the manifest check, and gates that arrive while a
 * generation is on screen are stored without restarting: a reconnect whose status probe failed
 * therefore left a ready session carrying an unreadable status and an empty capability list, and
 * the next view failure walled the host as `bundle-unavailable` — terminal, no retry, about a host
 * that had simply not answered.
 */
type MobileWebShellGateVerdict =
  /** Nothing is decidable yet. Two kinds rather than one so a dial that settles into a pending
   *  status still counts as a change worth restarting on. */
  | { readonly kind: 'dialling' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'status-unreadable' }
  | { readonly kind: 'wall'; readonly verdict: MobileWebShellBlockedVerdict }
  | { readonly kind: 'open' }

function gateVerdict(gates: MobileWebShellGates): MobileWebShellGateVerdict {
  if (gates.reachability === 'connecting') {
    return { kind: 'dialling' }
  }
  if (gates.reachability === 'unreachable') {
    return { kind: 'offline' }
  }
  if (gates.statusPending) {
    return { kind: 'pending' }
  }
  // Never a wall on an unreadable status: the empty capability list it leaves behind is
  // indistinguishable from a desktop that ships no bundle, and that wall tells the wrong story. It
  // is not a wait either — the gate settles once per host screen and does not probe again — so the
  // one honest answer is to say the status could not be read and let a fresh gate reopen it.
  if (!gates.statusReadable) {
    return { kind: 'status-unreadable' }
  }
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest: null
  })
  // Which block, not why: any blocked verdict walls, and the wall reads its own reason.
  return verdict.kind === 'blocked' ? { kind: 'wall', verdict } : { kind: 'open' }
}

/**
 * The gate verdict as one comparable value.
 *
 * A restart is worth taking only when this changes. The gates object is rebuilt on every status
 * refetch and every connection event, and most of those say exactly what the last one said: a
 * reconnect cycle that re-derives the same verdict used to re-sweep the staging tree and flip an
 * offline screen to a spinner and back for as long as the cycle ran.
 */
function gateKey(gates: MobileWebShellGates): string {
  return gateVerdict(gates).kind
}

/**
 * The step the gate takes, and every entry into the flow goes through it.
 *
 * The first run, the one "Try again" returns to, and the recovery a failed view triggers, which
 * passes the delete it owes as `before` so the cache goes whatever the gate then decides.
 */
function startFlow(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  patch: Partial<MobileWebShellSession> = {},
  before: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  // A new flow, so nothing the replaced one has in flight can land on this one. That is also what
  // keeps a status refetch arriving mid-check from running the cache read and the download twice.
  const base = { ...patch, gates, flow: session.flow + 1 }
  const verdict = gateVerdict(gates)
  if (verdict.kind === 'wall') {
    return step(session, { ...base, state: { kind: 'wall', verdict: verdict.verdict } }, before)
  }
  if (verdict.kind === 'status-unreadable') {
    return step(
      session,
      {
        ...base,
        state: {
          kind: 'failed',
          reason: 'status-unreadable',
          retriedOnce: patch.retriedOnce ?? session.retriedOnce
        }
      },
      before
    )
  }
  if (verdict.kind === 'dialling' || verdict.kind === 'pending') {
    return step(session, { ...base, state: CHECKING }, before)
  }
  // Offline sweeps and reads the cache exactly as a connected host does. What it skips is the
  // compat check, and `onCacheRead` is where that shows.
  return step(session, { ...base, state: CHECKING }, [...before, { kind: 'open-cache' }])
}

/** Puts a generation that is already on disk on screen. The only producer of `open-generation`. */
function openCached(
  session: MobileWebShellSession,
  generation: CachedGeneration,
  patch: Partial<MobileWebShellSession> = {}
): MobileWebShellStep {
  return step(session, { ...patch, state: { kind: 'activating' } }, [
    {
      kind: 'open-generation',
      directory: generation.directory,
      buildId: generation.buildId,
      totalBytes: generation.totalBytes
    }
  ])
}

function onCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null
): MobileWebShellStep {
  const gates = session.gates
  if (gates === null) {
    return step(session, { cached: generation })
  }
  if (gates.reachability === 'connecting') {
    // A dial in progress is not a host that cannot be reached: opening the cache here would skip a
    // compat check the connection about to land is what makes answerable.
    return step(session, { cached: generation })
  }
  if (gates.reachability === 'unreachable') {
    // No compat check on this path, by design: the generation was compatible when it was cached and
    // a host nobody can reach cannot have changed since. The next entry while connected re-checks.
    return generation === null
      ? step(session, { cached: null, state: { kind: 'offline' } })
      : openCached(session, generation, { cached: generation })
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
    return openCached(session, cached)
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
 *
 * Only `ready` hears any of it. The view exists in no other state, so a report arriving outside one
 * is from a view that has already been taken off screen: the second failure of a native batch that
 * the first one's recovery has already answered, or a mount that a wall or a retry has replaced.
 * Acting on it would strand the recovery already in flight — the delete-and-refetch would be made
 * terminal while its own cache read was still coming back, and that read would then drag the
 * session back to checking behind a failure screen.
 */
function onShellFailed(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason
): MobileWebShellStep {
  if (session.state.kind !== 'ready') {
    return step(session, {})
  }
  const failed = { kind: 'failed', reason, retriedOnce: session.retriedOnce } as const
  if (reason === 'isolation-unavailable') {
    return step(session, { state: failed })
  }
  if (reason === 'render-process-gone') {
    return session.remountedOnce
      ? step(session, { state: failed })
      : step(session, { remountedOnce: true }, [{ kind: 'remount' }])
  }
  if (session.retriedOnce || session.gates === null) {
    return step(session, { state: failed })
  }
  // Through the gate, not straight back to the manifest check: the gates a ready session holds are
  // whatever the last reconnect stored, so a recovery that trusted them walled hosts whose status
  // had gone unreadable underneath a workspace that was, until this failure, working.
  return startFlow(session, session.gates, { retriedOnce: true, cached: null }, [
    { kind: 'delete-cache' }
  ])
}

function onDownloadFailed(
  session: MobileWebShellSession,
  failure: MobileWebShellReadFailure
): MobileWebShellStep {
  const cached = session.cached
  if (failure === 'transport' && cached !== null) {
    // The link went, not the bundle. A generation already on disk was compatible when it was
    // written, and it is the same one the offline gate would have opened had the reachability
    // change arrived before this rejection did; which of the two lands first is a race.
    return openCached(session, cached)
  }
  return step(session, {
    state: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce }
  })
}

/**
 * One transition of the hybrid shell session: a state and the effects the runner owes it.
 *
 * Pure, so every rule above is a table test rather than a simulator run. The runner may drop an
 * effect's result (an unmount, a host change) but must never invent one, and a result it reports
 * late is dropped here by its flow rather than by whatever state the session happens to be in.
 */
export function reduceMobileWebShellSession(
  session: MobileWebShellSession,
  event: MobileWebShellSessionEvent
): MobileWebShellStep {
  if ('flow' in event && event.flow !== session.flow) {
    return step(session, {})
  }
  switch (event.type) {
    case 'gates-changed':
      return awaitsGates(session.state) &&
        (session.gates === null || gateKey(session.gates) !== gateKey(event.gates))
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
      return onDownloadFailed(session, event.failure)
    case 'shell-failed':
      return onShellFailed(session, event.reason)
    case 'retry-pressed':
      // Clears both latches, so the delete-and-refetch and the remount are each available again.
      // Only here: a reconnect is not a reason to grant a second remount of the same session.
      return session.gates === null
        ? step(session, {
            retriedOnce: false,
            remountedOnce: false,
            state: CHECKING,
            flow: session.flow + 1
          })
        : startFlow(session, session.gates, {
            retriedOnce: false,
            remountedOnce: false,
            cached: null
          })
  }
}
