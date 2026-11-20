// Serialize release changes per runtime; rename commits installation, so later cancellation cannot undo it.
// Removal runs only inside the host ownership fence, never beside installation.

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../shared/agent-launch/installation/managed-runtime-install'
import type { MainHttpClient } from '../network/http-client'
import { RevisionedState } from '../runtime/events/revisioned-state'
import {
  linkedRuntimeRelease,
  linkRuntimeRelease,
  reclaimRuntimeReleases,
  resolveInstalledRuntimeRelease,
  RUNTIME_RELEASE_LINK,
  runtimeReleaseLink,
  type ManagedRuntime,
  type ReportedRuntimeRelease
} from './managed-runtime-release'
import { installFailureText, installRuntimeRelease } from './managed-runtime-release-install'
import { refreshRuntimePin } from './managed-runtime-latest-release'

const DEADLINE_MS = 45 * 60_000
const AUTO_UPDATE_RETRY_MS = 60 * 60_000

export type ManagedRuntimeInstallationDeps = {
  dataDirectory: string
  findExternal: () => Promise<boolean>
  /** Told the release launches resolve to each time this reads the disk; null when none is whole. */
  onRelease?: (release: ReportedRuntimeRelease | null) => void
  /** Reject unless no host workload uses this runtime. */
  fence: (work: () => Promise<void>) => Promise<void>
  fetcher?: MainHttpClient['fetch']
}

type Run = { id: string; controller: AbortController; committed: boolean }

const releaseChangeListeners = new Set<() => void>()
export function onManagedRuntimeReleasesChanged(listener: () => void): () => void {
  releaseChangeListeners.add(listener)
  return () => releaseChangeListeners.delete(listener)
}
type InstalledFacts = Omit<ManagedRuntimeInstallState, 'agent' | 'revision' | 'operation'>

const unavailableText = (label: string): string =>
  `${label} is not available on ${process.platform} ${process.arch}.`

export class ManagedRuntimeInstallation {
  private readonly state = new RevisionedState<ManagedRuntimeOperation | null>(null)
  private readonly root: string
  private running: Run | null = null
  private mutation: Promise<void>
  private facts: { phase: string; read: Promise<InstalledFacts> } | null = null
  /** One attempt per release per hour, so a failing update isn't redownloaded on every use. */
  private lastAutoUpdate: { version: string; at: number } | null = null
  private reported: ReportedRuntimeRelease | null = null

  constructor(
    private readonly agent: string,
    private readonly runtime: ManagedRuntime,
    private readonly deps: ManagedRuntimeInstallationDeps
  ) {
    this.root = runtime.root(deps.dataDirectory)
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
    return { agent: this.agent, revision, ...(await facts.read), operation }
  }

  subscribe(onChange: () => void): () => void {
    return this.state.subscribe(onChange)
  }

  private async readInstalledFacts(): Promise<InstalledFacts> {
    const pin = this.runtime.pin()
    const { release, broken, unreadable } = resolveInstalledRuntimeRelease(this.root, pin)
    if (!unreadable) {
      void this.report(release?.folder ?? null)
    }
    // Unreadable is not absent; preserve clients’ last known installation state.
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
      canRemove: release !== null || broken.length > 0,
      source,
      ...(this.runtime.refreshPin && { updatesAutomatically: true as const })
    }
  }

  /** Bring Orca's own copy to the latest release; never installs one nobody asked for or touches a user's own. */
  async updateIfBehind(): Promise<void> {
    if (!this.runtime.refreshPin || this.running) {
      return
    }
    const state = await this.status()
    if (
      state.source === 'managed' &&
      state.installedVersion !== null &&
      state.available &&
      state.version !== null &&
      !state.installedCurrent &&
      !this.running
    ) {
      const { lastAutoUpdate } = this
      if (
        lastAutoUpdate?.version === state.version &&
        Date.now() - lastAutoUpdate.at < AUTO_UPDATE_RETRY_MS
      ) {
        return
      }
      this.lastAutoUpdate = { version: state.version, at: Date.now() }
      this.install()
    }
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
        // Reread the disk now so onRelease learns the outcome even when no client is watching.
        void this.status(false).catch(() => {})
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
      await refreshRuntimePin(this.runtime, signal)
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
      await this.link(join(this.root, pin.version))
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
      // Unknown active release means no release is provably stale.
      console.warn(`[managed-runtime] ${this.agent} releases unreadable; not reclaiming this run`)
      return
    }
    void this.report(release?.folder ?? null)
    if (release) {
      await this.link(release.folder)
      await this.report(release.folder)
    }
    await this.reclaimOlderThan(release?.version ?? null, null)
  }

  /** Launches learn the release before any await; the terminal link follows once it is confirmed. */
  private async report(folder: string | null): Promise<void> {
    const { onRelease } = this.deps
    if (!onRelease) {
      return
    }
    const known = this.reported?.folder === folder ? this.reported.link : null
    this.reported = folder === null ? null : { folder, link: known }
    onRelease(this.reported)
    const link = folder === null ? null : await runtimeReleaseLink(this.root, folder)
    // A newer read may have reported another release meanwhile.
    if (folder !== null && this.reported?.folder === folder && this.reported.link !== link) {
      this.reported = { folder, link }
      onRelease(this.reported)
    }
  }

  /** Terminals reach releases through the link; without it they keep the versioned folder. */
  private async link(folder: string): Promise<void> {
    await linkRuntimeRelease(this.root, folder).catch((error: unknown) => {
      console.warn(`[managed-runtime] ${this.agent} release link not updated:`, error)
    })
  }

  /** Keep the release launches resolve to, the one running chats may still use, and the one terminals' link reaches. */
  private async reclaimOlderThan(current: string | null, previous: string | null): Promise<void> {
    const linked = await linkedRuntimeRelease(this.root)
    const keep = [current, previous, RUNTIME_RELEASE_LINK, linked].filter((name) => name !== null)
    const failed = await reclaimRuntimeReleases(this.root, keep).catch((error: unknown) => [
      String(error)
    ])
    if (failed.length > 0) {
      console.warn(`[managed-runtime] old ${this.agent} releases not removed:`, failed)
    }
  }
}
