import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import { evaluateMobileWebBundleCompat } from '../transport/mobile-web-bundle-compat'
import type {
  CachedGeneration,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellReadFailure,
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import {
  awaitsGates,
  cachedGenerationWall,
  CHECKING,
  gateKey,
  gateState,
  gateVerdict,
  NATIVE_ROUTE
} from './mobile-web-shell-gates'
import { routeViewOf } from './page-route-policy'
import { CLEAR_PAGE_DOCUMENT_STATE, pageDocumentStatePatch } from './page-document-state'
import { openByOwnRoutes, openCached, rendersRoute } from './mobile-web-shell-cached-generation'
import { step } from './mobile-web-shell-session-step'

export function createMobileWebShellSession(routePathname: string): MobileWebShellSession {
  return {
    routePathname,
    pageRoutes: [],
    pageRouteGrants: [],
    routeGrants: [],
    state: CHECKING,
    retriedOnce: false,
    remountedOnce: false,
    pageReady: false,
    pageReportsPaint: false,
    pagePainted: false,
    pageBackClaimed: false,
    gates: null,
    cached: null,
    updateNotice: null,
    flow: 0
  }
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
  const base = { updateNotice: null, ...patch, gates, flow: session.flow + 1 }
  const gated = gateState(gateVerdict(gates), patch.retriedOnce ?? session.retriedOnce)
  if (gated !== null) {
    return step(session, { ...base, state: gated }, before)
  }
  // Offline sweeps and reads the cache exactly as a connected host does. What it skips is the
  // compat check, and `onCacheRead` is where that shows.
  return step(session, { ...base, state: CHECKING }, [...before, { kind: 'open-cache' }])
}

/** Puts a generation that is already on disk on screen. The only producer of `open-generation`.
 *  `andThen` is the disk work that opening one may owe, which runs after the view has its bytes. */
function onCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null
): MobileWebShellStep {
  const gates = session.gates
  // Neither says the host cannot be reached: a dial in progress is a connection about to land, and
  // gates that have not arrived have said nothing yet. Opening the cache on either would skip a
  // compat check that the settled answer is what makes answerable.
  if (gates === null || gates.reachability === 'connecting') {
    return step(session, { cached: generation })
  }
  if (gates.reachability === 'unreachable') {
    // No compat check on this path, by design: the generation was compatible when it was cached and
    // a host nobody can reach cannot have changed since. The next entry while connected re-checks.
    if (generation === null) {
      return step(session, { cached: null, state: { kind: 'offline' } })
    }
    // The cached bundle's own list, which is the only one an unreachable host can be judged by.
    return openByOwnRoutes(session, generation, { patch: { cached: generation } })
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
  // Before the compat verdict, because a route that stays native has nothing to wall about: a
  // bundle this shell could not open is not a reason to refuse a screen it was never going to open.
  const { pageRoutes, pageRouteGrants, routeGrants } = routeViewOf(
    manifest.routes,
    session.routePathname
  )
  // Same build id is the same bytes, because the id is their digest: a route-grant edit publishes
  // the generation already on disk under a newer manifest. Read before this route's verdict,
  // because that verdict is about this route while the manifest is the truth about the whole
  // generation — a list that takes this screen native, or names a bundle this shell cannot open,
  // still grants or revokes the other routes those assets serve, and what is stored beside them is
  // the whole of the next offline verdict. The compat facts come across with the routes, so what
  // the held generation records and what the persist writes to disk stay the one manifest.
  const cached = session.cached
  const same: CachedGeneration | null =
    cached === null || cached.buildId !== manifest.buildId
      ? null
      : { ...cached, routes: manifest.routes, compat: manifest }
  const persist: readonly MobileWebShellSessionEffect[] =
    same === null ? [] : [{ kind: 'persist-manifest', manifest: manifest.wire }]
  if (!rendersRoute(pageRoutes, session.routePathname)) {
    return step(
      session,
      { cached: same ?? cached, pageRoutes, pageRouteGrants, routeGrants, state: NATIVE_ROUTE },
      persist
    )
  }
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest
  })
  if (verdict.kind === 'blocked') {
    // The one same-build read that is not written, and the held generation keeps its own routes
    // with it: disk holds the last manifest this shell accepted, and an offline entry skips the
    // compat check. Writing one this shell has just walled would have the next offline entry open
    // a page under the grants of a bundle it had declared it cannot read.
    return step(session, { state: { kind: 'wall', verdict } })
  }
  if (same !== null) {
    return openCached(
      session,
      same,
      { cached: same, pageRoutes, pageRouteGrants, routeGrants },
      persist
    )
  }
  return step(
    session,
    {
      pageRoutes,
      pageRouteGrants,
      routeGrants,
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

/**
 * The read did not produce a generation, and what follows is decided by what is already on disk.
 *
 * With nothing cached there is nothing to show, so the refusal is the screen. With a generation
 * cached there is: it is the same one the offline gate opens without being asked. Refusing the new
 * bytes was right — a truncated asset does not hash, and a host that will not answer has not been
 * read — but a wall over an intact workspace refuses a screen twice. The same branch either way,
 * because the link going and the bundle being refused leave the phone holding exactly the same
 * thing.
 *
 * Judged against the host first, unlike the offline branch: it was compatible when it was written,
 * and this host can be reached and may have moved since — which is usually why an update was there
 * to fail. A generation outside its window earns the wall, not the download-failed screen.
 *
 * Only the bundle-side refusal is named: a link that went says nothing about an update having been
 * there to fail, and the notice would be claiming a generation this phone never heard of.
 */
function onDownloadFailed(
  session: MobileWebShellSession,
  failure: MobileWebShellReadFailure
): MobileWebShellStep {
  const cached = session.cached
  const gates = session.gates
  if (cached === null || gates === null) {
    return step(session, {
      state: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce }
    })
  }
  // The gates may have moved under the download: a `fetching` session does not await them, so the
  // verdict here is read fresh and answered with the shell's one answer for it.
  const verdict = gateVerdict(gates)
  const gated = gateState(verdict, session.retriedOnce)
  if (gated !== null) {
    return step(session, { state: gated })
  }
  return openByOwnRoutes(session, cached, {
    served: { updateNotice: failure === 'bundle' ? 'update-failed' : null },
    wall: cachedGenerationWall(verdict, gates, cached.compat)
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
        ...CLEAR_PAGE_DOCUMENT_STATE,
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
      // Only the session id changes, so the view remounts against the same verified bytes. A new
      // key is a new document, so whatever the last one said is no longer evidence about this one.
      // The flow goes with it: the wait the retired document armed would otherwise expire onto a
      // healthy page that is still inside its own, and take a working workspace off screen.
      return session.state.kind === 'ready'
        ? step(session, {
            ...CLEAR_PAGE_DOCUMENT_STATE,
            flow: session.flow + 1,
            state: { ...session.state, sessionId: event.sessionId }
          })
        : step(session, {})
    case 'download-failed':
      return onDownloadFailed(session, event.failure)
    case 'shell-failed':
      return onShellFailed(session, event.reason)
    case 'document-started':
      // A replacement document inherits nothing: what the last one declared and painted says
      // nothing about this one, and leaving its paint latched uncovers the view over a blank tree.
      // The flow goes with it for the same reason `remounted` moves it — the retired document's
      // readiness wait would otherwise expire onto a replacement that is still loading.
      return session.state.kind === 'ready'
        ? step(session, { ...CLEAR_PAGE_DOCUMENT_STATE, flow: session.flow + 1 })
        : step(session, {})
    case 'document-loaded':
      // Nothing to wait on outside `ready`, and nothing to wait for once the page has spoken: the
      // two orders this can arrive in are a race, and the latch is what makes either one fine.
      return session.state.kind === 'ready' && !session.pageReady
        ? step(session, {}, [{ kind: 'await-page-ready' }])
        : step(session, {})
    case 'page-ready':
    case 'page-painted':
    case 'page-back-claim':
      return step(session, pageDocumentStatePatch(session, event))
    case 'page-ready-deadline':
      // A document that finished and never said a word is a document that did not load, whatever
      // the WebView reported: `document-load-failed` is what drops the generation and fetches once.
      return session.pageReady ? step(session, {}) : onShellFailed(session, 'document-load-failed')
    case 'retry-pressed':
      // Clears both latches, so the delete-and-refetch and the remount are each available again.
      // Only here: a reconnect is not a reason to grant a second remount of the same session.
      return session.gates === null
        ? step(session, {
            retriedOnce: false,
            remountedOnce: false,
            updateNotice: null,
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
