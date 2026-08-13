import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { isDaemonGoneError } from './daemon-pty-adapter'
import { DaemonProtocolError } from './daemon-errors'

/** client.ts rejects a sent request with this shape once its budget expires. */
const REQUEST_TIMED_OUT = /timed out after \d+ms/

/**
 * Only a daemon that looks unreachable should cost the next terminal its persistence. A spawn
 * can fail for reasons that say nothing about the daemon's health — an unusable cwd, a bad
 * profile — and demoting on those degrades a session the daemon would have served fine.
 */
function daemonLooksUnreachable(error: unknown): boolean {
  return (
    isDaemonGoneError(error) ||
    (error instanceof DaemonProtocolError && REQUEST_TIMED_OUT.test(error.message))
  )
}

/**
 * Only a request that was actually sent can hide a session the daemon created before the answer
 * was lost. A failure that never reached it cannot have created anything, so pinning that id
 * would strand later attempts on a daemon that has nothing of theirs.
 */
function mayHaveCreatedTheSession(error: unknown): boolean {
  return (
    error instanceof DaemonProtocolError &&
    (error.message === 'Connection lost' || REQUEST_TIMED_OUT.test(error.message))
  )
}

export const DEGRADED_DAEMON_RECOVERY_RETRY_MS = 30_000

export class DegradedDaemonFreshSpawnRouter {
  private target: IPtyProvider
  private recovery: Promise<boolean> | null = null
  private retryAfterMs = 0

  constructor(
    private readonly current: IPtyProvider,
    private readonly fallback: IPtyProvider,
    private readonly sessionProviders: Map<string, IPtyProvider>,
    private readonly probeCurrent: (() => Promise<boolean>) | null
  ) {
    this.target = fallback
  }

  get routesToFallback(): true | undefined {
    return this.target === this.fallback ? true : undefined
  }

  supportsGitGuardHost(sessionId?: string): boolean {
    const provider = (sessionId ? this.sessionProviders.get(sessionId) : undefined) ?? this.target
    return provider.supportsGitCredentialGuardHost?.(sessionId) === true
  }

  canProvideSnapshot(sessionId: string): boolean {
    return (
      this.sessionProviders.get(sessionId)?.canProvideAuthoritativeBufferSnapshot?.(sessionId) ===
      true
    )
  }

  async recover(): Promise<boolean> {
    if (this.target === this.current) {
      return true
    }
    if (!this.probeCurrent) {
      return false
    }
    if (Date.now() < this.retryAfterMs) {
      return false
    }
    if (this.recovery) {
      return this.recovery
    }
    const recovery = this.probeCurrent()
      .catch(() => false)
      .then((healthy) => {
        if (healthy) {
          this.target = this.current
          console.info('[daemon] PTY spawn health recovered; fresh terminals are daemon-backed')
        } else {
          this.retryAfterMs = Date.now() + DEGRADED_DAEMON_RECOVERY_RETRY_MS
        }
        return healthy
      })
      .finally(() => {
        if (this.recovery === recovery) {
          this.recovery = null
        }
      })
    this.recovery = recovery
    return recovery
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const mapped = opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined
    const target = mapped ?? this.target
    let result: PtySpawnResult
    try {
      result = await target.spawn(opts)
    } catch (error) {
      // Why route back: recovery was a one-way flip on a two-way condition. A daemon that
      // answers one health check and wedges again kept every later spawn pointed at it, and a
      // spawn there costs a hello timeout plus a full launcher re-classification — per terminal,
      // for the rest of the session. Sending the next one to the fallback costs a terminal
      // without daemon persistence instead, and the next probe can promote it back.
      if (target === this.current) {
        // Two independent things, and conflating them cost a fix each way. Pinning protects
        // THIS id: the spawn may already have created it on the daemon and lost the reply, so
        // letting a retry reach the fallback would answer with a local shell under the same id
        // while the original keeps running. Demoting protects the NEXT terminal, which is a
        // different session entirely and cannot be shadowed by this one.
        if (opts.sessionId && mayHaveCreatedTheSession(error)) {
          this.sessionProviders.set(opts.sessionId, target)
        }
        // Why not `!opts.sessionId`: every production fresh spawn mints an id before it gets
        // here (ipc/pty.ts assigns spawnOptions.sessionId), so keying the demotion off its
        // absence made the demotion unreachable outside tests — and left every later terminal
        // paying a hello timeout plus a full re-classification against a daemon already known
        // to be failing. `attachOnly` is the real discriminator: an attach that names a session
        // never reaches this router at all.
        if (opts.attachOnly !== true && daemonLooksUnreachable(error)) {
          this.target = this.fallback
          this.retryAfterMs = Date.now() + DEGRADED_DAEMON_RECOVERY_RETRY_MS
          console.warn(
            '[daemon] Fresh terminals routed back to the local provider: the daemon failed a spawn after recovering'
          )
        }
      }
      throw error
    }
    if (!result.exitedBeforeSpawnReply) {
      this.sessionProviders.set(result.id, target)
    }
    return result
  }
}
