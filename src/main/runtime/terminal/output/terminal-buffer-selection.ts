import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './headless-terminal-state'
import type { TerminalOscLinkRange } from '../../../../shared/terminal/links/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type { ProviderTerminalBufferWait } from '../records/runtime-terminal-state-records'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './provider-snapshot-budget'
import type { RuntimeProviderSnapshotReadOptions } from './provider-snapshot-read-options'
import {
  sameProviderFrameGrid,
  type ProviderVisibleRead
} from '../lifecycle/terminal-view-resources'

export abstract class OrcaRuntimeWithSerializeTerminalBufferFromAvailableState extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  protected abstract captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number,
    publishMode?: boolean
  ): Promise<PtyProviderBufferSnapshot | null>

  protected async serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> {
    if (this.hasHostHistoryAuthority(ptyId)) {
      return this.serializeProviderTerminalBuffer(ptyId, opts)
    }
    const restoredSnapshot = await this.serializePreferredRestoredTerminalBuffer(ptyId, opts)
    if (restoredSnapshot) {
      return restoredSnapshot
    }
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, opts)
    if (headlessSnapshot) {
      return headlessSnapshot
    }

    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    if (!rendererSnapshot) {
      return this.serializeProviderTerminalBuffer(ptyId, opts)
    }
    if (rendererSnapshot.data.length > 0) {
      return rendererSnapshot
    }
    // Why: parked desktop panes register serializers before their xterm has
    // hydrated. Treat that empty shell as provisional so retained provider
    // history can restore mobile without forcing the desktop pane to mount.
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
    return providerSnapshot &&
      (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
      ? providerSnapshot
      : rendererSnapshot
  }

  /**
   * A host-owned binding's daemon is the first and terminal history source: main and renderer
   * models are projections, so an unavailable answer stays unavailable.
   */
  hasHostHistoryAuthority(ptyId: string): boolean {
    return this.ptyController?.getTerminalHistoryAuthority?.(ptyId)?.owner === 'host'
  }

  protected async serializePreferredRestoredTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ) {
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      return null
    }
    // Pre-attach bytes are only a suffix; older providers can fall back to the renderer.
    return (
      (await this.serializeProviderTerminalBuffer(ptyId, opts)) ??
      (await this.serializeRendererTerminalBuffer(ptyId, opts))
    )
  }

  async serializeRendererTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
  } | null> {
    if (this.ptyController?.hasRendererSerializer?.(ptyId) === false) {
      return null
    }
    let rendererSnapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      cwd?: string | null
      lastTitle?: string
      oscLinks?: TerminalOscLinkRange[]
      pendingEscapeTailAnsi?: string
      kittyKeyboardFlags?: number
    } | null = null
    try {
      rendererSnapshot = await (this.ptyController?.serializeBuffer?.(ptyId, {
        scrollbackRows: opts.scrollbackRows
      }) ?? Promise.resolve(null))
    } catch {
      // Why: terminal snapshots should not depend on a mounted renderer pane.
      // If renderer serialization races reload/unmount, callers can still use
      // their existing null fallback paths.
    }
    return rendererSnapshot
      ? this.preferTrackedLastTitle(ptyId, {
          ...rendererSnapshot,
          cwd: rendererSnapshot.cwd ?? this.terminalCwdByPtyId.get(ptyId),
          source: 'renderer' as const,
          ...(rendererSnapshot.pendingEscapeTailAnsi
            ? { pendingEscapeTailAnsi: rendererSnapshot.pendingEscapeTailAnsi }
            : {})
        })
      : null
  }

  /**
   * The current visible read for this PTY's generation, grid and kind, or a new one. Synchronous
   * and runs nothing: callers install the stages they need before their first await.
   */
  protected joinProviderVisibleRead(ptyId: string, currentFrame: boolean): ProviderVisibleRead {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const grid = this.getTerminalSize(ptyId)
    const current = this.providerVisibleStateReadsByPtyId.get(ptyId)
    if (
      current &&
      !current.retired &&
      current.generation === generation &&
      current.currentFrame === currentFrame &&
      sameProviderFrameGrid(current.grid, grid)
    ) {
      return current
    }
    // A differently qualified read is displaced: its continuations may no longer publish.
    this.retireProviderVisibleRead(ptyId)
    const entry: ProviderVisibleRead = { generation, grid, currentFrame, attempts: 0, pending: 0 }
    this.providerVisibleStateReadsByPtyId.set(ptyId, entry)
    return entry
  }

  /** Keeps the read's entry current while `promise` runs; the last settlement removes that exact entry. */
  protected trackProviderVisibleWork<T>(
    ptyId: string,
    entry: ProviderVisibleRead,
    promise: Promise<T>
  ): Promise<T> {
    entry.pending += 1
    const release = (): void => {
      entry.pending -= 1
      if (entry.pending === 0 && this.providerVisibleStateReadsByPtyId.get(ptyId) === entry) {
        this.providerVisibleStateReadsByPtyId.delete(ptyId)
      }
    }
    void promise.then(release, release)
    return promise
  }

  /** Runs one caller inside the visible read it joins (or was handed), holding it until the caller returns. */
  protected withProviderVisibleRead<T>(
    ptyId: string,
    currentFrame: boolean,
    run: (entry: ProviderVisibleRead) => Promise<T>,
    joined?: ProviderVisibleRead
  ): Promise<T> {
    const entry = joined ?? this.joinProviderVisibleRead(ptyId, currentFrame)
    return this.trackProviderVisibleWork(ptyId, entry, run(entry))
  }

  /** Only the exact current entry of the current lifecycle may publish, return or write retry state. */
  protected ownsProviderVisibleRead(ptyId: string, entry: ProviderVisibleRead): boolean {
    return (
      !entry.retired &&
      this.providerVisibleStateReadsByPtyId.get(ptyId) === entry &&
      this.getPtyLifecycleGeneration(ptyId) === entry.generation
    )
  }

  /**
   * An eligible pending acquisition is adopted as this read's capture: current generation, never
   * one a grid change retired, and a current frame only on its own grid. Otherwise a new capture,
   * shared with other consumers only when no current acquisition holds the slot.
   */
  protected acquireVisibleRaw(
    ptyId: string,
    entry: ProviderVisibleRead
  ): Promise<PtyProviderBufferSnapshot | null> {
    const acquisitions = entry.currentFrame
      ? this.providerFrameAcquisitionsByPtyId
      : this.providerBufferAcquisitionsByPtyId
    const existing = acquisitions.get(ptyId)
    const current =
      existing?.generation === entry.generation &&
      (!entry.currentFrame || sameProviderFrameGrid(existing.grid ?? null, entry.grid))
    if (existing && current && !existing.visibleRetired && !existing.timedOut) {
      return existing.promise
    }
    const promise = this.captureProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: 0 },
      entry.generation,
      false
    )
    if (!current) {
      const acquisition = {
        generation: entry.generation,
        scrollbackRows: 0,
        promise,
        timedOut: false,
        ...(entry.currentFrame ? { grid: entry.grid } : {})
      }
      acquisitions.set(ptyId, acquisition)
      void promise.finally(() => {
        if (acquisitions.get(ptyId) === acquisition) {
          acquisitions.delete(ptyId)
        }
      })
    }
    return promise
  }

  /** One supplied deadline for a whole read: each call gives the options with the time left. */
  protected spendProviderSnapshotDeadline(
    options: RuntimeProviderSnapshotReadOptions
  ): () => RuntimeProviderSnapshotReadOptions {
    const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs
    return () =>
      deadline === null ? options : { ...options, timeoutMs: Math.max(0, deadline - Date.now()) }
  }

  protected async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean; currentFrame?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    return (await this.awaitProviderTerminalBuffer(ptyId, opts, wait)).snapshot
  }

  /** `late` is the capture still running when the bounded wait gave up, so a caller can act once it lands. */
  protected async awaitProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean; currentFrame?: boolean } = {}
  ): Promise<ProviderTerminalBufferWait> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
    const acquisitions = wait.currentFrame
      ? this.providerFrameAcquisitionsByPtyId
      : this.providerBufferAcquisitionsByPtyId
    // A current frame joins only one taken for the PTY's present grid.
    const grid = wait.currentFrame ? this.getTerminalSize(ptyId) : undefined
    let acquisition = acquisitions.get(ptyId)
    const current =
      acquisition?.generation === generation &&
      (!wait.currentFrame || sameProviderFrameGrid(acquisition.grid ?? null, grid ?? null))
    if (current && acquisition?.timedOut) {
      return { snapshot: null, late: acquisition.promise }
    }
    if (!acquisition || !current || acquisition.scrollbackRows < scrollbackRows) {
      const promise = this.captureProviderTerminalBuffer(ptyId, opts, generation)
      acquisition = {
        generation,
        scrollbackRows,
        promise,
        timedOut: false,
        ...(grid !== undefined ? { grid } : {})
      }
      acquisitions.set(ptyId, acquisition)
      void promise.finally(() => {
        if (acquisitions.get(ptyId) === acquisition) {
          acquisitions.delete(ptyId)
        }
      })
    }
    if (acquisition.timedOut) {
      return { snapshot: null, late: acquisition.promise }
    }
    // Every reader shares this bound: a provider that never answers must not hold its caller.
    const result = await withTimeout<
      { settled: true; value: PtyProviderBufferSnapshot | null } | { settled: false }
    >(
      acquisition.promise.then((value) => ({ settled: true as const, value })),
      wait.timeoutMs ?? AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      { settled: false as const }
    )
    if (!result.settled) {
      if (wait.retireOnTimeout) {
        acquisition.timedOut = true
      }
      return { snapshot: null, late: acquisition.promise }
    }
    return { snapshot: result.value, late: null }
  }
}
