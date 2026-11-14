import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { isHostAttachTimeout } from './relay-recovery-failure-count'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../../src/shared/remote-runtime/relay/mobile-relay-close-codes'

// 4404s further apart than this belong to separate episodes (the phone slept, or went direct).
const EPISODE_GAP_MS = 2 * 60_000
// Per host: a truly offline desktop must not turn every foreground phone into a steady director
// client. The gap after each resolve doubles, 5 -> 10 -> 20 -> 40 -> 60 min, until the relay dial
// succeeds or the phone connects some other way.
const RESOLVE_MIN_INTERVAL_MS = 5 * 60_000
const RESOLVE_MAX_INTERVAL_MS = 60 * 60_000

// An edge that still claims a desktop which moved answers 4404 until its fence lands, so the cell
// alone never reveals the move. Resolve on the 2nd consecutive 4404 of an episode, then on the
// 4th, 8th, 16th..., and only once the doubling gap since the last resolve has passed. Attach
// timeouts never count: the desktop was seated on this cell. Any other outcome, including an
// abort, or the phone having connected (direct or relay) since the last 4404, ends the episode.
export class RelayHostOfflineStreak {
  private streak = 0
  private resolveAtStreak = 2
  private lastHostOfflineAt = Number.NEGATIVE_INFINITY
  private lastResolveAt = Number.NEGATIVE_INFINITY
  private resolveIntervalMs = RESOLVE_MIN_INTERVAL_MS

  constructor(
    private readonly lastConnectedAt: () => number | null,
    private readonly now: () => number = Date.now
  ) {}

  shouldResolve(error: Error | null): boolean {
    const now = this.now()
    const hostOffline =
      error instanceof RelayOuterError &&
      error.code === MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE &&
      !isHostAttachTimeout(error)
    const connectedSince =
      (this.lastConnectedAt() ?? Number.NEGATIVE_INFINITY) > this.lastHostOfflineAt
    if (error === null || connectedSince) {
      this.lastResolveAt = Number.NEGATIVE_INFINITY
      this.resolveIntervalMs = RESOLVE_MIN_INTERVAL_MS
    }
    if (!hostOffline || connectedSince || now - this.lastHostOfflineAt > EPISODE_GAP_MS) {
      this.streak = 0
      this.resolveAtStreak = 2
    }
    if (!hostOffline) {
      return false
    }
    this.lastHostOfflineAt = now
    this.streak += 1
    if (this.streak < this.resolveAtStreak || now - this.lastResolveAt < this.resolveIntervalMs) {
      return false
    }
    if (this.lastResolveAt !== Number.NEGATIVE_INFINITY) {
      this.resolveIntervalMs = Math.min(this.resolveIntervalMs * 2, RESOLVE_MAX_INTERVAL_MS)
    }
    this.resolveAtStreak *= 2
    this.lastResolveAt = now
    return true
  }
}
