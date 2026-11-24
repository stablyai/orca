export const REMOTE_CLIENT_WORKTREE_RECONCILE_INTERVAL_MS = 60_000

type RemoteClientWorktreeReconcileDeps<R extends { id: string }> = {
  /** Local Git repos whose admin dir this process can read without waking a distro or a remote host. */
  listProbeableRepos: () => R[]
  probe: (repo: R) => Promise<string | null>
  notifyChanged: (repoId: string) => void
  intervalMs?: number
}

/** Without a live watcher (headless serve, hidden or closed window) a worktree removed in a shell would never reach paired clients; this probes while one is connected. */
export class RemoteClientWorktreeReconcile<R extends { id: string }> {
  private retainers = 0
  // Bumped when the last client leaves so a probe begun before the gap cannot seed the next baseline.
  private epoch = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly fingerprints = new Map<string, string>()
  // Own single-flight: timeouts do not cancel readdir/stat, so a wedged mount must not stack probes.
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: RemoteClientWorktreeReconcileDeps<R>) {}

  retain(): () => void {
    this.retainers++
    if (this.retainers === 1) {
      this.runTick()
      this.timer = setInterval(
        () => this.runTick(),
        this.deps.intervalMs ?? REMOTE_CLIENT_WORKTREE_RECONCILE_INTERVAL_MS
      )
      this.timer.unref?.()
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.retainers--
      if (this.retainers === 0) {
        if (this.timer) {
          clearInterval(this.timer)
          this.timer = null
        }
        this.epoch++
        this.fingerprints.clear()
      }
    }
  }

  private runTick(): void {
    this.tick().catch((error) => {
      console.error('[worktrees] remote-client worktree reconcile tick failed', error)
    })
  }

  private async tick(): Promise<void> {
    const repos = this.deps.listProbeableRepos()
    const live = new Set(repos.map((repo) => repo.id))
    for (const repoId of this.fingerprints.keys()) {
      if (!live.has(repoId)) {
        this.fingerprints.delete(repoId)
      }
    }
    await Promise.all(repos.map((repo) => this.reconcileRepo(repo)))
  }

  private async reconcileRepo(repo: R): Promise<void> {
    if (this.inFlight.has(repo.id)) {
      return
    }
    const epoch = this.epoch
    this.inFlight.add(repo.id)
    try {
      const fingerprint = await this.deps.probe(repo)
      // Unknown means the filesystem could not answer; keep the baseline rather than report a change.
      if (fingerprint === null || epoch !== this.epoch) {
        return
      }
      const previous = this.fingerprints.get(repo.id)
      this.fingerprints.set(repo.id, fingerprint)
      if (previous !== undefined && previous !== fingerprint) {
        this.deps.notifyChanged(repo.id)
      }
    } catch (error) {
      // One bad repo must not abort the rest of the tick.
      console.error('[worktrees] remote-client worktree reconcile failed for repo', repo.id, error)
    } finally {
      this.inFlight.delete(repo.id)
    }
  }
}
