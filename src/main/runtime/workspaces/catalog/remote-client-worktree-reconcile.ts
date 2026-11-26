import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'

export const REMOTE_CLIENT_WORKTREE_RECONCILE_INTERVAL_MS = 60_000
export const REMOTE_CLIENT_WORKTREE_PROBE_TIMEOUT_MS = 5_000
const PROBE_CONCURRENCY = 4
// Abandoned probes hold libuv threads, so a repo waits until its abandoned probe settles.
const MAX_ABANDONED_PROBES_PER_REPO = 1

type RemoteClientWorktreeReconcileDeps<R extends { id: string }> = {
  /** Local Git repos readable without waking a distro or a remote host. */
  listProbeableRepos: () => R[]
  probe: (repo: R) => Promise<string | null>
  /** True when the probe saw no `.git/worktrees` directory (single-worktree repo). */
  isEmptyAdminDir?: (fingerprint: string) => boolean
  notifyChanged: (repoId: string) => void
  intervalMs?: number
  probeTimeoutMs?: number
}

/** Paired clients only learn of out-of-band worktree changes from the watcher, which headless and hidden servers lack. */
export class RemoteClientWorktreeReconcile<R extends { id: string }> {
  private retainers = 0
  // Bumped when the last client leaves so an older probe cannot seed the next baseline.
  private epoch = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly fingerprints = new Map<string, string>()
  // Clients that read a linked worktree between ticks need a push if `.git/worktrees` vanishes again before the next tick.
  private readonly observedLinkedWorktreeVersion = new Map<string, number>()
  // Timeouts do not cancel readdir/stat, so a wedged mount must not stack probes.
  private readonly inFlight = new Set<string>()
  private readonly abandoned = new Map<string, number>()

  constructor(private readonly deps: RemoteClientWorktreeReconcileDeps<R>) {}

  noteLinkedWorktreesObserved(repoId: string): void {
    if (this.retainers === 0) {
      return
    }
    this.observedLinkedWorktreeVersion.set(
      repoId,
      (this.observedLinkedWorktreeVersion.get(repoId) ?? 0) + 1
    )
  }

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
        this.observedLinkedWorktreeVersion.clear()
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
    for (const repoId of this.observedLinkedWorktreeVersion.keys()) {
      if (!live.has(repoId)) {
        this.observedLinkedWorktreeVersion.delete(repoId)
      }
    }
    await mapWithConcurrency(repos, PROBE_CONCURRENCY, (repo) => this.reconcileRepo(repo))
  }

  private async reconcileRepo(repo: R): Promise<void> {
    if (
      this.inFlight.has(repo.id) ||
      (this.abandoned.get(repo.id) ?? 0) >= MAX_ABANDONED_PROBES_PER_REPO
    ) {
      return
    }
    const epoch = this.epoch
    const observedVersion = this.observedLinkedWorktreeVersion.get(repo.id) ?? 0
    this.inFlight.add(repo.id)
    try {
      const fingerprint = await this.probeWithTimeout(repo)
      // Unknown keeps the baseline rather than reporting a change.
      if (fingerprint === null || epoch !== this.epoch) {
        return
      }
      const previous = this.fingerprints.get(repo.id)
      this.fingerprints.set(repo.id, fingerprint)
      const vanishedAfterObservedRead =
        observedVersion > 0 && this.deps.isEmptyAdminDir?.(fingerprint) === true
      if (
        observedVersion > 0 &&
        this.observedLinkedWorktreeVersion.get(repo.id) === observedVersion
      ) {
        this.observedLinkedWorktreeVersion.delete(repo.id)
      }
      if ((previous !== undefined && previous !== fingerprint) || vanishedAfterObservedRead) {
        this.deps.notifyChanged(repo.id)
      }
    } catch (error) {
      // One bad repo must not stop the rest of the tick.
      console.error('[worktrees] remote-client worktree reconcile failed for repo', repo.id, error)
    } finally {
      this.inFlight.delete(repo.id)
    }
  }

  /** Resolves null after the timeout; the abandoned probe's late answer is dropped. */
  private probeWithTimeout(repo: R): Promise<string | null> {
    let probe: Promise<string | null>
    try {
      probe = Promise.resolve(this.deps.probe(repo))
    } catch (error) {
      probe = Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        this.abandoned.set(repo.id, (this.abandoned.get(repo.id) ?? 0) + 1)
        console.warn('[worktrees] remote-client worktree probe timed out for repo', repo.id)
        const release = (): void => {
          const left = (this.abandoned.get(repo.id) ?? 1) - 1
          if (left <= 0) {
            this.abandoned.delete(repo.id)
          } else {
            this.abandoned.set(repo.id, left)
          }
        }
        probe.then(release, release)
        resolve(null)
      }, this.deps.probeTimeoutMs ?? REMOTE_CLIENT_WORKTREE_PROBE_TIMEOUT_MS)
      probe.then(
        (value) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(value)
          }
        },
        (error) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(error)
          }
        }
      )
    })
  }
}
