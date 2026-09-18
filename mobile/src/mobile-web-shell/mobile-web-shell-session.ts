import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { evaluateMobileWebBundleCompat } from '../transport/mobile-web-bundle-compat'
import type {
  CachedGeneration,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellReachability,
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
  return state.kind === 'checking' || state.kind === 'offline'
}

/** The first step of the flow, and the one "Try again" returns to. */
function startFlow(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  patch: Partial<MobileWebShellSession> = {}
): MobileWebShellStep {
  // A new flow, so nothing the replaced one has in flight can land on this one. That is also what
  // keeps a status refetch arriving mid-check from running the cache read and the download twice.
  const base = { ...patch, gates, flow: session.flow + 1 }
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
  return step(
    session,
    { retriedOnce: true, cached: null, state: CHECKING, flow: session.flow + 1 },
    [{ kind: 'delete-cache' }, { kind: 'open-cache' }]
  )
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
