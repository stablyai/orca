import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { githubAvatarIcon, githubAvatarSlug } from '../../../shared/repo-icon'
import { probeRepoUpstream } from '../../github/client/fetch/repo-slug-upstream'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { isWslMoveRepoBlocked } from '../../persistence/moving-wsl-projects/wsl-move-background-backoff'
import { blockedWslDistroForPath, wslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'

type MetadataJob = {
  store: RuntimeStore
  repo: Repo
  background: boolean
  active: boolean
  waiters: number
  onStarted: Set<() => void>
  done: Promise<boolean>
  finish: (changed: boolean) => void
}

export class RuntimeRepositoryForkBackfill {
  private started = false
  private draining = false
  private readonly jobs = new Map<RuntimeStore, Map<string, MetadataJob>>()
  private readonly queue: MetadataJob[] = []

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
    for (const repo of repos) {
      const job = this.admit(repo)
      if (!job || job.background) {
        continue
      }
      job.background = true
      batch.push(job.done)
    }
    this.drain()
    // Each admitted finite batch owns its notice, independent of later arrivals.
    const changes = await Promise.all(batch)
    if (changes.some(Boolean)) {
      this.notifyChanged()
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
    job.waiters++
    try {
      const started =
        job.active ||
        (await new Promise<boolean>((resolve) => {
          const onStarted = (): void => {
            clearTimeout(timer)
            job.onStarted.delete(onStarted)
            resolve(true)
          }
          const timer = setTimeout(() => {
            job.onStarted.delete(onStarted)
            resolve(false)
          }, 10_000)
          job.onStarted.add(onStarted)
          this.drain()
        }))
      if (started) {
        await job.done
      }
      return started
    } finally {
      job.waiters--
      if (!job.active && !job.background && job.waiters === 0) {
        const index = this.queue.indexOf(job)
        if (index !== -1) {
          this.queue.splice(index, 1)
        }
        this.retire(job, false)
      }
    }
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
      waiters: 0,
      onStarted: new Set(),
      done,
      finish
    }
    jobs.set(key, job)
    this.queue.push(job)
    return job
  }

  private drain(): void {
    if (this.draining) {
      return
    }
    this.draining = true
    void this.processQueue()
  }

  private async processQueue(): Promise<void> {
    try {
      let job: MetadataJob | undefined
      while ((job = this.queue.shift())) {
        job.active = true
        for (const onStarted of job.onStarted) {
          onStarted()
        }
        let changed = false
        try {
          changed = await this.probe(job)
        } catch {
          /* Optional metadata stays retryable. */
        }
        this.retire(job, changed)
      }
    } finally {
      this.draining = false
    }
  }

  private retire(job: MetadataJob, changed: boolean): void {
    const jobs = this.jobs.get(job.store)
    jobs?.delete(this.key(job.repo))
    if (jobs?.size === 0) {
      this.jobs.delete(job.store)
    }
    job.onStarted.clear()
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
    const iconUnchanged = JSON.stringify(current.repoIcon) === JSON.stringify(repo.repoIcon)
    if (
      current.repoIcon === undefined ||
      (iconUnchanged && current.repoIcon?.type === 'image' && current.repoIcon.source === 'github')
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
