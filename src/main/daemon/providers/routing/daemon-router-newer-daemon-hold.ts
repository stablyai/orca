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
import { TerminalSessionOwnerUnverifiedError } from '../../protocol/daemon-errors'

/** The saved id to hold, or null for a routed session, a new one, or no newer daemon. */
export function heldSessionId(opts: PtyHeldSpawnRequest, routed: boolean): string | null {
  const { sessionId } = opts
  // Missing history doesn't prove the saved shell exited, so every saved id holds until an owner answers.
  return routed || !sessionId || opts.isNewSession || !isHoldingForNewerProtocolDaemon()
    ? null
    : sessionId
}

/** No compatible daemon runs the id: refuse, unless every held newer daemon has exited since startup. */
function holdUnlessNewerDaemonsExited(): void {
  if (recheckNewerProtocolHold()) {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
}

/**
 * The compatible daemon that runs a held saved id; undefined only after a definite miss once every
 * held newer daemon has exited, else a refusal. Each daemon is asked for this id first; only an
 * unanswered probe reads the full inventory, and an unknown answer never releases the hold.
 */
export async function resolveHeldOwner(
  sessionId: string,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  adapters: readonly DaemonPtyAdapter[]
): Promise<DaemonPtyAdapter | undefined> {
  const verdicts = await Promise.all(
    adapters.map((adapter) => adapter.probePtyLiveness(sessionId).catch(() => null))
  )
  if (verdicts.every((verdict) => verdict !== null)) {
    const live = adapters.filter((_, index) => verdicts[index] === true)
    if (live.length === 1) {
      return live[0]
    }
    if (live.length === 0) {
      holdUnlessNewerDaemonsExited()
      return undefined
    }
  }
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind === 'owner') {
    return resolution.provider
  }
  if (resolution.kind === 'unknown') {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  holdUnlessNewerDaemonsExited()
  return undefined
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
    if (sessionId === null) {
      return undefined
    }
    // The caller already searched every compatible daemon; only the newer daemons are left to check.
    return opts.ownerSearched
      ? Promise.resolve().then(holdUnlessNewerDaemonsExited)
      : resolveHeld({ ...opts, sessionId }).then(() => {})
  }
}

// Long enough to cover spawn preparation; an older answer is asked again.
const ADMITTED_OWNER_TTL_MS = 10_000

/** Owners the early hold found, handed to their spawns so each is asked once. */
export class HeldOwnerAdmissions {
  private readonly admitted = new Map<string, { owner: DaemonPtyAdapter; at: number }>()

  admit(sessionId: string, owner: DaemonPtyAdapter): void {
    const now = Date.now()
    // Insertion order is age order, so stale entries are only ever at the front.
    for (const [id, entry] of this.admitted) {
      if (now - entry.at < ADMITTED_OWNER_TTL_MS) {
        break
      }
      this.admitted.delete(id)
    }
    this.admitted.delete(sessionId)
    this.admitted.set(sessionId, { owner, at: now })
  }

  take(sessionId: string): DaemonPtyAdapter | undefined {
    const entry = this.admitted.get(sessionId)
    this.admitted.delete(sessionId)
    return entry && Date.now() - entry.at < ADMITTED_OWNER_TTL_MS ? entry.owner : undefined
  }
}

type DaemonRouterDispatch = {
  sessionAdapters: ReadonlyMap<string, DaemonPtyAdapter>
  current: DaemonPtyAdapter
  legacy: readonly DaemonPtyAdapter[]
  exitProof: LegacyDaemonExitProof
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
}

/** The router's spawn dispatch and its early hold, which share one owner lookup per held id. */
export class DaemonRouterHeldSpawnGate {
  private readonly admissions = new HeldOwnerAdmissions()

  constructor(private readonly dispatch: () => DaemonRouterDispatch) {}

  /** Where a spawn goes; under the hold a probed owner is only attached, so an exit meanwhile fails rather than duplicates. */
  target = async <T extends PtyHeldSpawnRequest>(
    opts: T
  ): Promise<{ target: DaemonPtyAdapter; spawnOpts: T }> => {
    const router = this.dispatch()
    const routed = opts.sessionId ? router.sessionAdapters.get(opts.sessionId) : undefined
    if (routed) {
      return { target: routed, spawnOpts: opts }
    }
    const heldId = heldSessionId(opts, false)
    if (heldId === null) {
      const owner = await findLegacySessionOwner(
        opts,
        router.current,
        router.legacy,
        router.exitProof
      )
      return { target: owner ?? router.current, spawnOpts: opts }
    }
    const owner = this.admissions.take(heldId) ?? (await this.heldOwner(heldId, opts, router))
    return owner
      ? { target: owner, spawnOpts: { ...opts, attachOnly: true } }
      : { target: router.current, spawnOpts: opts }
  }

  refuse = heldSpawnRefusal(
    (id) => this.dispatch().sessionAdapters.has(id),
    async (opts) => {
      const owner = await this.heldOwner(opts.sessionId, opts, this.dispatch())
      if (owner) {
        this.admissions.admit(opts.sessionId, owner)
      }
    }
  )

  private async heldOwner(
    sessionId: string,
    opts: PtyHeldSpawnRequest,
    router: DaemonRouterDispatch
  ): Promise<DaemonPtyAdapter | undefined> {
    const { current, legacy, exitProof, ownerResolver } = router
    let owner: DaemonPtyAdapter | undefined
    try {
      owner = await findLegacySessionOwner(opts, current, legacy, exitProof)
    } catch (error) {
      // Under the hold an owner no compatible daemon can vouch for may be the newer daemon's.
      if (error instanceof TerminalSessionOwnerUnverifiedError) {
        throw new Error(NEWER_DAEMON_HOLD_ERROR)
      }
      throw error
    }
    if (owner || legacy.length === 0) {
      return owner ?? (await resolveHeldOwner(sessionId, ownerResolver, [current]))
    }
    // The lookup above already asked the current daemon and every older one.
    holdUnlessNewerDaemonsExited()
    return undefined
  }
}
