import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import type { PtyHeldSpawnRequest } from '../../../providers/pty/provider-contract'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
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

export async function resolveHeldOwner(
  sessionId: string,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<DaemonPtyAdapter> {
  // Unknown inventory cannot authorize a duplicate shell or agent.
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind !== 'owner') {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  return resolution.provider
}

type DaemonRouterDispatch = {
  sessionAdapters: ReadonlyMap<string, DaemonPtyAdapter>
  current: DaemonPtyAdapter
  legacy: readonly DaemonPtyAdapter[]
  exitProof: LegacyDaemonExitProof
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
}

/** Spawn dispatch's target: the routed owner, else a probed current or legacy owner, else the newer-daemon hold. */
export async function routeSpawnOrHold(
  opts: PtyHeldSpawnRequest,
  router: DaemonRouterDispatch
): Promise<DaemonPtyAdapter> {
  const { sessionAdapters, current, legacy, exitProof, ownerResolver } = router
  const owner =
    (opts.sessionId ? sessionAdapters.get(opts.sessionId) : undefined) ??
    (await findLegacySessionOwner(opts, current, legacy, exitProof))
  const sessionId = heldSessionId(opts, owner !== undefined)
  if (sessionId === null) {
    return owner ?? current
  }
  // With older daemons the lookup already asked every one of them; with none it skipped the current one.
  const live =
    legacy.length > 0 ? false : await current.probePtyLiveness(sessionId).catch(() => null)
  if (live === false) {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  // Only an unanswered probe needs the full inventory.
  return live ? current : resolveHeldOwner(sessionId, ownerResolver)
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

// Long enough to cover spawn preparation; an older answer is probed again.
const ADMITTED_OWNER_TTL_MS = 10_000

/** The router's dispatch and its early hold; an owner the early hold admitted is handed to its spawn, so it is probed once. */
export class DaemonRouterHeldSpawnGate {
  private readonly admitted = new Map<string, { owner: DaemonPtyAdapter; at: number }>()

  constructor(private readonly dispatch: () => DaemonRouterDispatch) {}

  target = (opts: PtyHeldSpawnRequest): Promise<DaemonPtyAdapter> => {
    const admitted = opts.sessionId ? this.admitted.get(opts.sessionId) : undefined
    if (opts.sessionId && admitted) {
      this.admitted.delete(opts.sessionId)
      if (!opts.isNewSession && Date.now() - admitted.at < ADMITTED_OWNER_TTL_MS) {
        return Promise.resolve(admitted.owner)
      }
    }
    return routeSpawnOrHold(opts, this.dispatch())
  }

  refuse = heldSpawnRefusal(
    (id) => this.dispatch().sessionAdapters.has(id),
    async (opts) => {
      const owner = await routeSpawnOrHold(opts, this.dispatch())
      const now = Date.now()
      for (const [id, entry] of this.admitted) {
        if (now - entry.at >= ADMITTED_OWNER_TTL_MS) {
          this.admitted.delete(id)
        }
      }
      this.admitted.set(opts.sessionId, { owner, at: now })
    }
  )
}
