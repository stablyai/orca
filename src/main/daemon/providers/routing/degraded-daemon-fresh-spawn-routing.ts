import {
  acquireProspectivePtySpawn,
  validateProspectivePtySpawn
} from '../../../pty/prospective-pty-spawn'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'

export const DEGRADED_DAEMON_RECOVERY_RETRY_MS = 30_000

export class DegradedDaemonFreshSpawnRouter {
  private target: IPtyProvider
  private recovery: Promise<boolean> | null = null
  private retryAfterMs = 0

  constructor(
    private readonly current: IPtyProvider,
    private readonly fallback: IPtyProvider,
    private readonly sessionProviders: Map<string, IPtyProvider>,
    private readonly probeCurrent: (() => Promise<boolean>) | null,
    private readonly owner?: IPtyProvider
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

  async admit(opts: PtySpawnOptions) {
    const target =
      (opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined) ?? this.target
    const nested = await acquireProspectivePtySpawn(target, opts)
    if (!nested) {
      return null
    }
    let held = true
    return {
      target,
      nested,
      currentSync: () =>
        held &&
        nested.currentSync() &&
        ((opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined) ??
          this.target) === target,
      current: async () =>
        held &&
        (await nested.current()) &&
        ((opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined) ??
          this.target) === target,
      release: () => {
        held = false
        nested.release()
      }
    }
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const mapped = opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined
    const admission = this.owner ? await validateProspectivePtySpawn(this.owner, opts) : undefined
    const target = admission?.target ?? mapped ?? this.target
    const result = await target.spawn(opts)
    if (!result.exitedBeforeSpawnReply) {
      this.sessionProviders.set(result.id, target)
    }
    return result
  }
}
