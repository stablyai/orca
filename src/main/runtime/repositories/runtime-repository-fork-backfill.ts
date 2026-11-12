import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { githubAvatarIcon, githubAvatarSlug } from '../../../shared/repo-icon'
import { probeRepoUpstream } from '../../github/client/fetch/repo-slug-upstream'
import { GhExecutableAbsenceBatch } from '../../git/command-runner/hosted-cli/gh-executable-absence-batch'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { isWslMoveRepoBlocked } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'
import { blockedWslDistroForPath, wslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'

type MetadataJob = {
  store: RuntimeStore
  repo: Repo
  background: boolean
  active: boolean
  required: boolean
  batch?: GhExecutableAbsenceBatch
  done: Promise<boolean>
  finish: (changed: boolean) => void
}

export class RuntimeRepositoryForkBackfill {
  private started = false
  private active = 0
  private backgroundActive = 0
  private readonly jobs = new Map<RuntimeStore, Map<string, MetadataJob>>()
  private readonly requiredQueue = new Set<MetadataJob>()
  private readonly backgroundQueue = new Set<MetadataJob>()

  constructor(
    private readonly getStore: () => RuntimeStore | null,
    private readonly notifyChanged: () => void
  ) {}

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    void this.run()
  }

  run(): Promise<void> {
    return this.enqueue(
      (this.getStore()?.getRepos() ?? []).filter((repo) => repo.upstream === undefined)
    )
  }

  async enqueue(repos: readonly Repo[]): Promise<void> {
    const batch: Promise<boolean>[] = []
    const availability = new GhExecutableAbsenceBatch()
    try {
      for (const repo of repos) {
        const job = this.admit(repo)
        if (!job || job.background) {
          continue
        }
        job.background = true
        job.batch = availability
        if (!job.required && !job.active) {
          this.backgroundQueue.add(job)
        }
        batch.push(job.done)
      }
      this.drain()
      // Each admitted finite batch owns its notice, independent of later arrivals.
      const changes = await Promise.all(batch)
      if (changes.some(Boolean)) {
        this.notifyChanged()
      }
    } finally {
      availability.close()
    }
  }

  async resolve(repo: Repo): Promise<boolean> {
    if (this.current(this.getStore(), repo)?.upstream !== undefined) {
      return true
    }
    const job = this.admit(repo)
    if (!job) {
      return false
    }
    if (!job.required && !job.active) {
      this.backgroundQueue.delete(job)
      this.requiredQueue.add(job)
    }
    job.required = true
    this.drain()
    await job.done
    return true
  }

  private key(repo: Repo): string {
    return `${repo.id}\0${getRepoExecutionHostId(repo)}\0${repo.path}\0${repo.kind}`
  }

  private current(store: RuntimeStore | null, snapshot: Repo): Repo | undefined {
    if (!store || store !== this.getStore()) {
      return undefined
    }
    const host = getRepoExecutionHostId(snapshot)
    const found = store.getRepo(snapshot.id)
    const row =
      found && getRepoExecutionHostId(found) === host
        ? found
        : store
            .getRepos()
            .find(
              (candidate) =>
                candidate.id === snapshot.id && getRepoExecutionHostId(candidate) === host
            )
    return row &&
      row.path === snapshot.path &&
      row.kind === snapshot.kind &&
      row.kind !== 'folder' &&
      !getRepoSshConnectionId(row) &&
      !isWslMoveRepoBlocked(row)
      ? row
      : undefined
  }

  private admit(repo: Repo): MetadataJob | undefined {
    const store = this.getStore()
    const current = this.current(store, repo)
    if (!store || !current || (current.upstream !== undefined && current.repoIcon !== undefined)) {
      return undefined
    }
    let jobs = this.jobs.get(store)
    if (!jobs) {
      this.jobs.set(store, (jobs = new Map()))
    }
    const key = this.key(current)
    const existing = jobs.get(key)
    if (existing) {
      return existing
    }
    let finish!: MetadataJob['finish']
    const done = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const job: MetadataJob = {
      store,
      repo: { ...current },
      background: false,
      active: false,
      required: false,
      done,
      finish
    }
    jobs.set(key, job)
    return job
  }

  private drain(): void {
    while (this.active < 4) {
      const queue = this.requiredQueue.size ? this.requiredQueue : this.backgroundQueue
      if (queue === this.backgroundQueue && this.backgroundActive > 0) {
        return
      }
      const job = queue.values().next().value
      if (!job) {
        return
      }
      queue.delete(job)
      job.active = true
      this.active++
      const background = !job.required
      if (background) {
        this.backgroundActive++
      }
      void this.processJob(job, background)
    }
  }

  private async processJob(job: MetadataJob, background: boolean): Promise<void> {
    let changed = false
    try {
      changed = await (background && job.batch
        ? job.batch.run(() => this.probe(job))
        : this.probe(job))
    } catch {
      /* Optional metadata stays retryable. */
    } finally {
      this.active--
      if (background) {
        this.backgroundActive--
      }
      this.retire(job, changed)
      this.drain()
    }
  }

  private retire(job: MetadataJob, changed: boolean): void {
    const jobs = this.jobs.get(job.store)
    jobs?.delete(this.key(job.repo))
    if (jobs?.size === 0) {
      this.jobs.delete(job.store)
    }
    job.finish(changed)
  }

  private async probe(job: MetadataJob): Promise<boolean> {
    const { store, repo } = job
    let current = this.current(store, repo)
    if (!current) {
      return false
    }
    if (wslDistroForPath(repo.path) && (await blockedWslDistroForPath(repo.path))) {
      return false
    }
    current = this.current(store, repo)
    if (!current) {
      return false
    }
    const result = await probeRepoUpstream(repo.path, null, {}, current.upstream === undefined)
    current = this.current(store, repo)
    if (!current) {
      return false
    }
    const updates: Partial<Repo> = {}
    if (current.upstream === undefined && result.upstream !== undefined) {
      updates.upstream = result.upstream
    }
    if (
      current.repoIcon === undefined ||
      (current.repoIcon?.type === 'image' &&
        current.repoIcon.source === 'github' &&
        repo.repoIcon?.type === 'image' &&
        repo.repoIcon.source === 'github' &&
        JSON.stringify(current.repoIcon) === JSON.stringify(repo.repoIcon))
    ) {
      // Defined null is an explicit origin choice or a proved negative, never the late parent.
      const upstream = current.upstream === undefined ? result.upstream : current.upstream
      const slug = githubAvatarSlug(result.origin, upstream)
      const icon = slug ? githubAvatarIcon(slug) : undefined
      if (icon && JSON.stringify(icon) !== JSON.stringify(current.repoIcon)) {
        updates.repoIcon = icon
      }
    }
    return Object.keys(updates).length > 0 && !!store.updateRepo(current, updates)
  }
}
