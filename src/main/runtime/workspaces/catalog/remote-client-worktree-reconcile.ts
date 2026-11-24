export const REMOTE_CLIENT_WORKTREE_RECONCILE_INTERVAL_MS = 60_000

type ProbeResult = Promise<string | null> | 'in-flight'

type RemoteClientWorktreeReconcileDeps<R extends { id: string }> = {
  /** Local Git repos whose admin dir this process can read without waking a distro or a remote host. */
  listProbeableRepos: () => R[]
  probe: (repo: R) => ProbeResult
  notifyChanged: (repoId: string) => void
  intervalMs?: number
}

/** Without a live watcher (headless serve, hidden or closed window) a worktree removed in a shell would never reach paired clients; this probes while one is connected. */
export class RemoteClientWorktreeReconcile<R extends { id: string }> {
  private retainers = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly fingerprints = new Map<string, string>()

  constructor(private readonly deps: RemoteClientWorktreeReconcileDeps<R>) {}

  retain(): () => void {
    this.retainers++
    if (this.retainers === 1) {
      void this.tick()
      this.timer = setInterval(
        () => void this.tick(),
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
        // A baseline from before a gap could not tell a change made while nobody listened.
        this.fingerprints.clear()
      }
    }
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
    const probe = this.deps.probe(repo)
    if (probe === 'in-flight') {
      return
    }
    const fingerprint = await probe.catch(() => null)
    // Unknown means the filesystem could not answer; keep the baseline rather than report a change.
    if (fingerprint === null || this.retainers === 0) {
      return
    }
    const previous = this.fingerprints.get(repo.id)
    this.fingerprints.set(repo.id, fingerprint)
    if (previous !== undefined && previous !== fingerprint) {
      this.deps.notifyChanged(repo.id)
    }
  }
}
