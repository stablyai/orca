import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import type { PtyHeldSpawnRequest, PtySpawnOptions } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import {
  isHoldingForNewerProtocolDaemon,
  recheckNewerProtocolHold
} from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'
import { SessionNotFoundError } from '../../protocol/daemon-errors'

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
 * unanswered or listing-only probe reads the shared full inventory, and an unknown answer never releases the hold.
 */
export async function resolveHeldOwner(
  sessionId: string,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  adapters: readonly DaemonPtyAdapter[]
): Promise<DaemonPtyAdapter | undefined> {
  // A daemon that can only answer by listing every session is left to the shared inventory below.
  const verdicts = await Promise.all(
    adapters.map((adapter) =>
      adapter.probesSessionDirectly()
        ? adapter.probePtyLiveness(sessionId).catch(() => null)
        : Promise.resolve(null)
    )
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

/** Under the hold a saved id is only ever attached: a vanished or unattachable owner is the hold, never a new shell. */
export async function attachHeldSession(
  owner: DaemonPtyAdapter,
  opts: PtySpawnOptions
): Promise<PtySpawnResult> {
  // Daemons before native attach-only emulate it by creating and then killing, which can run a shell.
  if (!owner.attachesWithoutCreating()) {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  try {
    return await owner.spawn({ ...opts, attachOnly: true })
  } catch (error) {
    throw error instanceof SessionNotFoundError ? new Error(NEWER_DAEMON_HOLD_ERROR) : error
  }
}

/** The router's spawn dispatch and its early hold, which share one owner lookup per held id. */
export class DaemonRouterHeldSpawnGate {
  private readonly admissions = new HeldOwnerAdmissions()

  constructor(private readonly dispatch: () => DaemonRouterDispatch) {}

  /** Where a spawn goes and how it runs; a held saved id, routed or not, is only attached. */
  target = async (
    opts: PtySpawnOptions
  ): Promise<{ target: DaemonPtyAdapter; spawn: () => Promise<PtySpawnResult> }> => {
    const router = this.dispatch()
    const routed = opts.sessionId ? router.sessionAdapters.get(opts.sessionId) : undefined
    const heldId = heldSessionId(opts, false)
    if (heldId === null) {
      const target =
        routed ??
        (await findLegacySessionOwner(opts, router.current, router.legacy, router.exitProof)) ??
        router.current
      return { target, spawn: () => target.spawn(opts) }
    }
    const owner =
      routed ?? this.admissions.take(heldId) ?? (await this.heldOwner(heldId, opts, router))
    if (!owner) {
      // Every held newer daemon has exited since startup, so this is an ordinary start again.
      return { target: router.current, spawn: () => router.current.spawn(opts) }
    }
    return { target: owner, spawn: () => attachHeldSession(owner, opts) }
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
    // An unverifiable older owner stays a retryable unverified error, not a hold whose Reopen stops jobs.
    const owner = await findLegacySessionOwner(opts, current, legacy, exitProof)
    if (owner || legacy.length === 0) {
      return owner ?? (await resolveHeldOwner(sessionId, ownerResolver, [current]))
    }
    // The lookup above already asked the current daemon and every older one.
    holdUnlessNewerDaemonsExited()
    return undefined
  }
}
