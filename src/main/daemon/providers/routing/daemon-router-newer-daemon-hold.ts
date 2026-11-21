import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import type { PtyHeldSpawnRequest } from '../../../providers/pty/provider-contract'
import {
  isHoldingForNewerProtocolDaemon,
  recheckNewerProtocolHold
} from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'

/** The saved id to hold, or null for a routed session, a new one, or no newer daemon. */
function heldSessionId(opts: PtyHeldSpawnRequest, routed: boolean): string | null {
  const { sessionId } = opts
  // Missing history doesn't prove the saved shell exited, so every saved id holds until an owner answers.
  return routed || !sessionId || opts.isNewSession || !isHoldingForNewerProtocolDaemon()
    ? null
    : sessionId
}

/** No compatible daemon runs the id: refuse, unless every held newer daemon has exited since startup. */
async function holdUnlessNewerDaemonsExited(): Promise<void> {
  if (await recheckNewerProtocolHold()) {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
}

/**
 * The compatible daemon that runs a held saved id, recorded as its route so exits and identity
 * changes revoke it; refuses when none does. Each daemon is asked for this id first, and only an
 * unanswered or ambiguous answer reads the full inventory.
 */
export async function resolveHeldOwner(
  sessionId: string,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  adapters: readonly DaemonPtyAdapter[]
): Promise<DaemonPtyAdapter | undefined> {
  const verdicts = await Promise.all(
    adapters.map((adapter) => adapter.probePtyLiveness(sessionId).catch(() => null))
  )
  const live = adapters.filter((_, index) => verdicts[index] === true)
  if (live.length === 1) {
    ownerResolver.recordRoute(sessionId, live[0])
    return live[0]
  }
  if (live.length === 0 && verdicts.every((verdict) => verdict === false)) {
    await holdUnlessNewerDaemonsExited()
    return undefined
  }
  // Unknown inventory cannot authorize a duplicate shell or agent.
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind === 'owner') {
    return resolution.provider
  }
  await holdUnlessNewerDaemonsExited()
  return undefined
}

type DaemonRouterDispatch = {
  sessionAdapters: ReadonlyMap<string, DaemonPtyAdapter>
  current: DaemonPtyAdapter
  legacy: readonly DaemonPtyAdapter[]
  exitProof: LegacyDaemonExitProof
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
}

/** Spawn dispatch's target, and the daemon proven to run the saved id when one was found. */
async function dispatchTarget(
  opts: PtyHeldSpawnRequest,
  router: DaemonRouterDispatch
): Promise<{ target: DaemonPtyAdapter; owner?: DaemonPtyAdapter }> {
  const { sessionAdapters, current, legacy, exitProof, ownerResolver } = router
  const owner =
    (opts.sessionId ? sessionAdapters.get(opts.sessionId) : undefined) ??
    (await findLegacySessionOwner(opts, current, legacy, exitProof))
  const sessionId = heldSessionId(opts, owner !== undefined)
  if (sessionId === null) {
    return { target: owner ?? current, owner }
  }
  if (legacy.length > 0) {
    // The lookup above already asked the current daemon and every older one.
    await holdUnlessNewerDaemonsExited()
    return { target: current }
  }
  const held = await resolveHeldOwner(sessionId, ownerResolver, [current])
  return { target: held ?? current, owner: held }
}

/** Spawn dispatch's target: the routed owner, else a probed current or legacy owner, else the newer-daemon hold. */
export async function routeSpawnOrHold(
  opts: PtyHeldSpawnRequest,
  router: DaemonRouterDispatch
): Promise<DaemonPtyAdapter> {
  return (await dispatchTarget(opts, router)).target
}

/** The same hold, answered before main prepares anything under the saved id; undefined when none applies. */
export function heldSpawnRefusal(
  hasRoute: (sessionId: string) => boolean,
  // The dispatch's own owner lookup, so the early answer never differs from the spawn's.
  resolveHeld: (opts: PtyHeldSpawnRequest & { sessionId: string }) => Promise<unknown>
): (opts: PtyHeldSpawnRequest) => Promise<void> | undefined {
  return (opts) => {
    const routed = opts.sessionId !== undefined && hasRoute(opts.sessionId)
    const sessionId = opts.attachOnly ? null : heldSessionId(opts, routed)
    return sessionId === null ? undefined : resolveHeld({ ...opts, sessionId }).then(() => {})
  }
}

/** The router's dispatch and its early hold; an owner the early hold finds becomes a route its spawn reuses. */
export class DaemonRouterHeldSpawnGate {
  constructor(private readonly dispatch: () => DaemonRouterDispatch) {}

  target = (opts: PtyHeldSpawnRequest): Promise<DaemonPtyAdapter> =>
    routeSpawnOrHold(opts, this.dispatch())

  refuse = heldSpawnRefusal(
    (id) => this.dispatch().sessionAdapters.has(id),
    async (opts) => {
      const router = this.dispatch()
      const { owner } = await dispatchTarget(opts, router)
      // A proven owner becomes a route, so its spawn reuses it unless an exit or identity change revokes it.
      if (owner && !router.sessionAdapters.has(opts.sessionId)) {
        router.ownerResolver.recordRoute(opts.sessionId, owner)
      }
    }
  )
}
