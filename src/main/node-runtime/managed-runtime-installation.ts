// Serialize release changes per runtime; rename commits installation, so later cancellation cannot undo it.
// Removal runs only inside the host ownership fence, never beside installation.

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation,
  ManagedRuntimeProgram
} from '../../shared/agent-launch/installation/managed-runtime-install'
import type { MainHttpClient } from '../network/http-client'
import { RevisionedState, type RevisionClock } from '../runtime/events/revisioned-state'
import {
  reclaimRuntimeReleases,
  resolveInstalledRuntimeRelease,
  runtimeReleaseMayBePublished,
  type ManagedRuntime
} from './managed-runtime-release'
import { installFailureText, installRuntimeRelease } from './managed-runtime-release-install'
import { ManagedRuntimeAutoUpdater } from './managed-runtime-auto-updater'

const DEADLINE_MS = 45 * 60_000

export type ManagedRuntimeInstallationDeps = {
  dataDirectory: string
  program: ManagedRuntimeProgram
  findExternal: () => Promise<boolean>
  /** Told the release launches resolve to each time this reads the disk; null when none is whole. */
  onRelease?: (folder: string | null) => void
  /** False while Orca shouldn't keep this copy current; absent means it should. */
  updatesEnabled?: () => boolean
  /** Reject unless no host workload uses this runtime. */
  fence: (work: () => Promise<void>) => Promise<void>
  fetcher?: MainHttpClient['fetch']
  /** Shared with the agent's other installation, so a stream switching between them stays ordered. */
  revisions?: RevisionClock
}

type Run = {
  id: string
  controller: AbortController
  committed: boolean
  /** Stopped because automatic updates were turned off, not declined by the user. */
  stoppedBySwitch?: true
}

let releasesRevision = 0
/** Rises whenever an install or removal settles, so answers that read Orca's copies retire. */
export function managedRuntimeReleasesRevision(): number {
  return releasesRevision
}

const releaseChangeListeners = new Set<() => void>()
export function onManagedRuntimeReleasesChanged(listener: () => void): () => void {
  releaseChangeListeners.add(listener)
  return () => releaseChangeListeners.delete(listener)
}
type InstalledFacts = Omit<
  ManagedRuntimeInstallState,
  'agent' | 'program' | 'revision' | 'operation'
>

const unavailableText = (label: string): string =>
  `${label} is not available on ${process.platform} ${process.arch}.`

export class ManagedRuntimeInstallation {
  private readonly state: RevisionedState<ManagedRuntimeOperation | null>
  private readonly root: string
  private running: Run | null = null
  private mutation: Promise<void>
  private facts: { phase: string; read: Promise<InstalledFacts> } | null = null
  private readonly autoUpdater: ManagedRuntimeAutoUpdater

  constructor(
    private readonly agent: string,
    private readonly runtime: ManagedRuntime,
    private readonly deps: ManagedRuntimeInstallationDeps
  ) {
    this.state = new RevisionedState<ManagedRuntimeOperation | null>(null, deps.revisions)
    this.root = runtime.root(deps.dataDirectory)
    this.autoUpdater = new ManagedRuntimeAutoUpdater(runtime, this.root, {
      enabled: () => this.deps.updatesEnabled?.() !== false,
      busy: () => this.running !== null,
      status: () => this.status(),
      releases: (pin) => this.readReleases(pin),
      install: () => this.install()
    })
    this.mutation = this.reclaim()
  }

  /** Reread disk/PATH on fresh reads or phase changes, never byte-progress updates. */
  async status(fresh = true): Promise<ManagedRuntimeInstallState> {
    const { value: operation, revision } = this.state.get()
    const phase = `${operation?.id}:${operation?.phase}`
    let facts = this.facts
    if (fresh && this.runtime.refreshPin) {
      await this.runtime.refreshPin().catch((error: unknown) => {
        console.warn(`[managed-runtime] ${this.agent} latest release unknown:`, error)
      })
    }
    if (fresh || facts?.phase !== phase) {
      const read = this.readInstalledFacts()
      facts = { phase, read }
      this.facts = facts
      read.catch(() => {
        this.facts = this.facts?.read === read ? null : this.facts
      })
    }
    return {
      agent: this.agent,
      program: this.deps.program,
      revision,
      ...(await facts.read),
      operation
    }
  }

  subscribe(onChange: () => void): () => void {
    return this.state.subscribe(onChange)
  }

  private async readInstalledFacts(): Promise<InstalledFacts> {
    const pin = this.runtime.pin()
    const { release, broken, unreadable } = this.readReleases(pin)
    if (!unreadable) {
      this.deps.onRelease?.(release?.folder ?? null)
    }
    // Unreadable is not absent; preserve clients’ last known installation state.
    if (unreadable && !release?.current) {
      throw new Error(`Couldn't read the installed ${this.runtime.label} files on this host.`)
    }
    const source = (await this.deps.findExternal()) ? 'external' : release ? 'managed' : null
    const enabled = this.deps.updatesEnabled?.() !== false
    // A pinned update that will still run needs no Update; after a failure or Cancel it does.
    const pinPending = await this.autoUpdater.pending({ source }, { release, broken, unreadable })
    return {
      available: pin !== null,
      version: pin?.version ?? null,
      ...(pin && { downloadBytes: pin.archiveBytes }),
      installedVersion: release?.version ?? null,
      installedCurrent: release?.current ?? false,
      ...(pin && !release?.current && broken.includes(pin.version) && { damaged: true }),
      canRemove: release !== null || broken.length > 0,
      source,
      // A copy Orca isn't keeping current offers its own Update.
      ...(((this.runtime.refreshPin && enabled) || pinPending) && {
        updatesAutomatically: true as const
      })
    }
  }

  updateIfBehind(): Promise<void> {
    return this.autoUpdater.updateIfBehind(() => runtimeReleaseMayBePublished(this.root))
  }

  /** Turned off mid-download: stop the automatic install before it publishes, without declining it. */
  stopAutoUpdate(): void {
    const run = this.running
    if (run && this.autoUpdater.isAutomatic(run.id) && !run.committed) {
      run.stoppedBySwitch = true
      run.controller.abort()
    }
  }

  /** The releases under the root, all Orca's, and which one launches run. */
  private readReleases(pin = this.runtime.pin()) {
    return resolveInstalledRuntimeRelease(this.root, pin)
  }

  /** Join installs; canceled work must finish cleanup before another begins. */
  install(): ManagedRuntimeOperation {
    const { label } = this.runtime
    const pin = this.runtime.pin()
    // A runtime that follows its latest release looks it up when the install runs.
    if (!pin && !this.runtime.refreshPin) {
      throw new Error(unavailableText(label))
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
      totalBytes: pin?.archiveBytes ?? null
    }
    this.running = run
    this.state.set(operation)
    this.mutation = this.mutation.then(() => this.runInstall(run))
    return operation
  }

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

  runs(operationId: string): boolean {
    return this.state.get().value?.id === operationId
  }

  /** Await unwinding; already-committed installs succeed despite cancellation. */
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
    // Once aborted, unwinding progress is stale; only final outcomes may advance state.
    const settles =
      patch.phase === 'succeeded' || patch.phase === 'cancelled' || patch.phase === 'failed'
    if (operation?.id === run.id && (settles || !run.controller.signal.aborted)) {
      this.state.set({ ...operation, ...patch })
      if (settles) {
        void this.autoUpdater.settled({ ...operation, ...patch }, run.stoppedBySwitch === true)
        // Reread the disk now so onRelease learns the outcome even when no client is watching.
        void this.status(false).catch(() => {})
        releasesRevision += 1
        releaseChangeListeners.forEach((listener) => listener())
      }
    }
  }

  private async runInstall(run: Run): Promise<void> {
    const deadline = AbortSignal.timeout(DEADLINE_MS)
    const signal = AbortSignal.any([run.controller.signal, deadline])
    // The release chats ran before this install; they may still be running it.
    const previous = this.runtime.refreshPin
      ? ((await this.facts?.read.catch(() => null))?.installedVersion ?? null)
      : null
    try {
      await this.runtime.refreshPin?.(signal)
      const pin = this.runtime.pin()
      if (!pin) {
        throw new Error(unavailableText(this.runtime.label))
      }
      this.publish(run, { totalBytes: pin.archiveBytes })
      await installRuntimeRelease({
        agent: this.agent,
        runtime: this.runtime,
        root: this.root,
        pin,
        fetcher: this.deps.fetcher,
        signal,
        publish: (patch) => this.publish(run, patch),
        commit: () => {
          run.committed = true
        }
      })
      if (this.runtime.refreshPin) {
        await this.reclaimOlderThan(pin.version, previous)
      }
      this.publish(run, { phase: 'succeeded' })
    } catch (error) {
      if (run.committed) {
        console.warn(`[managed-runtime] ${this.agent} installed; staging not removed:`, error)
        this.publish(run, { phase: 'succeeded' })
      } else if (run.controller.signal.aborted) {
        this.publish(run, { phase: 'cancelled' })
      } else {
        const text = installFailureText(this.runtime.label, error, deadline)
        this.publish(run, { phase: 'failed', error: this.autoUpdater.failureText(text) })
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
    const { release, unreadable } = this.readReleases()
    if (!unreadable) {
      this.deps.onRelease?.(release?.folder ?? null)
    }
    if (unreadable) {
      // Unknown active release means no release is provably stale.
      console.warn(`[managed-runtime] ${this.agent} releases unreadable; not reclaiming this run`)
      return
    }
    await this.reclaimOlderThan(release?.version ?? null, null)
  }

  /** Keep the release launches resolve to and the one running chats may still use. */
  private async reclaimOlderThan(current: string | null, previous: string | null): Promise<void> {
    const keep = [current, previous].filter((version) => version !== null)
    const failed = await reclaimRuntimeReleases(this.root, keep).catch((error: unknown) => [
      String(error)
    ])
    if (failed.length > 0) {
      console.warn(`[managed-runtime] old ${this.agent} releases not removed:`, failed)
    }
  }
}
