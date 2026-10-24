// Installs a managed runtime when the person asks, on the host that runs its chats. One instance per
// runtime owns every change to its releases: it reclaims old ones once, first, then installs one at a
// time. Publishing the release by rename is the commit point; a cancel after it changes nothing.
// Remove deletes the releases only inside the host's ownership fence, never beside an install.

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../shared/managed-runtime-install'
import type { MainHttpClient } from '../network/http-client'
import { RevisionedState } from '../runtime/revisioned-state'
import {
  reclaimRuntimeReleases,
  resolveInstalledRuntimeRelease,
  type ManagedRuntime,
  type ManagedRuntimePin
} from './managed-runtime-release'
import { installFailureText, installRuntimeRelease } from './managed-runtime-release-install'

const DEADLINE_MS = 45 * 60_000

export type ManagedRuntimeInstallationDeps = {
  dataDirectory: string
  /** Whether a start would run a copy found outside Orca's releases (PATH, install folders). */
  findExternal: () => Promise<boolean>
  /** Runs `work` once nothing on this host runs the runtime; rejects without running it otherwise. */
  fence: (work: () => Promise<void>) => Promise<void>
  fetcher?: MainHttpClient['fetch']
}

type Run = { id: string; controller: AbortController; committed: boolean }

const releaseChangeListeners = new Set<() => void>()
/** Runs after any install or removal on this host ends, which can change what a start runs. */
export function onManagedRuntimeReleasesChanged(listener: () => void): () => void {
  releaseChangeListeners.add(listener)
  return () => releaseChangeListeners.delete(listener)
}
type InstalledFacts = Omit<ManagedRuntimeInstallState, 'agent' | 'revision' | 'operation'>

export class ManagedRuntimeInstallation {
  private readonly state = new RevisionedState<ManagedRuntimeOperation | null>(null)
  private readonly root: string
  private running: Run | null = null
  private mutation: Promise<void>
  private facts: { phase: string; read: Promise<InstalledFacts> } | null = null

  constructor(
    private readonly agent: string,
    private readonly runtime: ManagedRuntime,
    private readonly deps: ManagedRuntimeInstallationDeps
  ) {
    this.root = runtime.root(deps.dataDirectory)
    this.mutation = this.reclaim()
  }

  /** Disk and PATH are reread on a `fresh` read and when the phase changes, never for byte
   *  progress alone. */
  async status(fresh = true): Promise<ManagedRuntimeInstallState> {
    const { value: operation, revision } = this.state.get()
    const phase = `${operation?.id}:${operation?.phase}`
    let facts = this.facts
    if (fresh || facts?.phase !== phase) {
      const read = this.readInstalledFacts()
      facts = { phase, read }
      this.facts = facts
      // A failed read is retried by the next status, not replayed.
      read.catch(() => {
        this.facts = this.facts?.read === read ? null : this.facts
      })
    }
    return { agent: this.agent, revision, ...(await facts.read), operation }
  }

  /** Calls `onChange` after every state revision until the returned unsubscribe. */
  subscribe(onChange: () => void): () => void {
    return this.state.subscribe(onChange)
  }

  private async readInstalledFacts(): Promise<InstalledFacts> {
    const pin = this.runtime.pin()
    const { release, broken, unreadable } = resolveInstalledRuntimeRelease(this.root, pin)
    // Unknown is not absent: a failed read keeps each client's last answer.
    if (unreadable && !release?.current) {
      throw new Error(`Couldn't read the installed ${this.runtime.label} files on this host.`)
    }
    const source = (await this.deps.findExternal()) ? 'external' : release ? 'managed' : null
    return {
      available: pin !== null,
      version: pin?.version ?? null,
      ...(pin && { downloadBytes: pin.archiveBytes }),
      installedVersion: release?.version ?? null,
      installedCurrent: release?.current ?? false,
      ...(pin && !release?.current && broken.includes(pin.version) && { damaged: true }),
      // A damaged copy is removable too, though no launch runs it.
      canRemove: release !== null || broken.length > 0,
      source
    }
  }

  /** Joins the running install; one being cancelled finishes its cleanup before the next starts. */
  install(): ManagedRuntimeOperation {
    const { label } = this.runtime
    const pin = this.runtime.pin()
    if (!pin) {
      throw new Error(`${label} is not available on ${process.platform} ${process.arch}.`)
    }
    const current = this.state.get().value
    const { running } = this
    if (running && current?.kind === 'remove') {
      throw new Error(`${label} is being removed. Try again after it finishes.`)
    }
    if (current && current.id === running?.id && !running.controller.signal.aborted) {
      return current
    }
    const run: Run = { id: randomUUID(), controller: new AbortController(), committed: false }
    const operation: ManagedRuntimeOperation = {
      id: run.id,
      kind: 'install',
      phase: 'downloading',
      downloadedBytes: 0,
      totalBytes: pin.archiveBytes
    }
    this.running = run
    this.state.set(operation)
    this.mutation = this.mutation.then(() => this.runInstall(pin, run))
    return operation
  }

  /** Joins a running removal; refused while an install, or its cleanup, still runs. */
  remove(): ManagedRuntimeOperation {
    const current = this.state.get().value
    if (this.running && current?.kind === 'remove') {
      return current
    }
    if (this.running) {
      throw new Error(`${this.runtime.label} is installing. Try again after it finishes.`)
    }
    const run: Run = { id: randomUUID(), controller: new AbortController(), committed: false }
    const operation: ManagedRuntimeOperation = {
      id: run.id,
      kind: 'remove',
      phase: 'removing',
      downloadedBytes: 0,
      totalBytes: null
    }
    this.running = run
    this.state.set(operation)
    this.mutation = this.mutation.then(() => this.runRemove(run))
    return operation
  }

  /** Resolves with the outcome once the work has unwound: `cancelled`, or `succeeded` when it had
   *  already committed. No install queues behind a running one, so `mutation` ends with it. */
  async cancel(operationId: string): Promise<ManagedRuntimeOperation | null> {
    const current = this.state.get().value
    if (current?.id !== operationId) {
      throw new Error(`That ${this.runtime.label} installation is no longer running.`)
    }
    if (current.kind === 'remove') {
      throw new Error(`Removing ${this.runtime.label} cannot be cancelled.`)
    }
    const run = this.running
    if (run?.id === operationId && !run.committed) {
      run.controller.abort()
    }
    await this.mutation
    return this.state.get().value
  }

  private publish(run: Run, patch: Partial<ManagedRuntimeOperation>): void {
    const operation = this.state.get().value
    // Once aborted, only the outcome moves it: progress from the unwinding work is stale.
    const settles =
      patch.phase === 'succeeded' || patch.phase === 'cancelled' || patch.phase === 'failed'
    if (operation?.id === run.id && (settles || !run.controller.signal.aborted)) {
      this.state.set({ ...operation, ...patch })
      if (settles) {
        releaseChangeListeners.forEach((listener) => listener())
      }
    }
  }

  private async runInstall(pin: ManagedRuntimePin, run: Run): Promise<void> {
    const deadline = AbortSignal.timeout(DEADLINE_MS)
    try {
      await installRuntimeRelease({
        agent: this.agent,
        runtime: this.runtime,
        root: this.root,
        pin,
        fetcher: this.deps.fetcher,
        signal: AbortSignal.any([run.controller.signal, deadline]),
        publish: (patch) => this.publish(run, patch),
        commit: () => {
          run.committed = true
        }
      })
      this.publish(run, { phase: 'succeeded' })
    } catch (error) {
      if (run.committed) {
        console.warn(`[managed-runtime] ${this.agent} installed; staging not removed:`, error)
        this.publish(run, { phase: 'succeeded' })
      } else if (run.controller.signal.aborted) {
        this.publish(run, { phase: 'cancelled' })
      } else {
        this.publish(run, {
          phase: 'failed',
          error: installFailureText(this.runtime.label, error, deadline)
        })
      }
    } finally {
      this.running = this.running === run ? null : this.running
    }
  }

  private async runRemove(run: Run): Promise<void> {
    try {
      await this.deps.fence(() => rm(this.root, { recursive: true, force: true }))
      this.publish(run, { phase: 'succeeded' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish(run, { phase: 'failed', error: message })
    } finally {
      this.running = this.running === run ? null : this.running
    }
  }

  private async reclaim(): Promise<void> {
    const { release, unreadable } = resolveInstalledRuntimeRelease(this.root, this.runtime.pin())
    if (unreadable) {
      // Which release a launch runs is unknown, so nothing is provably stale.
      console.warn(`[managed-runtime] ${this.agent} releases unreadable; not reclaiming this run`)
      return
    }
    const failed = await reclaimRuntimeReleases(this.root, release?.version ?? null).catch(
      (error: unknown) => [String(error)]
    )
    if (failed.length > 0) {
      console.warn(`[managed-runtime] old ${this.agent} releases not removed:`, failed)
    }
  }
}
