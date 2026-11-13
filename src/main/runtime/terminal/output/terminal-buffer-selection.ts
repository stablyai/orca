import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './headless-terminal-state'
import type { TerminalOscLinkRange } from '../../../../shared/terminal/links/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type { ProviderTerminalBufferWait } from '../records/runtime-terminal-state-records'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './provider-snapshot-budget'
import {
  sameProviderFrameGrid,
  type ProviderVisibleRead
} from '../lifecycle/terminal-view-resources'
import type { RuntimeVisibleTerminalState } from '../records/runtime-terminal-state-records'

export abstract class OrcaRuntimeWithSerializeTerminalBufferFromAvailableState extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  protected abstract captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number
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
   * One owned visible read per PTY, joined only by a read of the same generation, grid and kind.
   * A read displaced by a resize or another kind may not publish or return its frame.
   */
  protected ownProviderVisibleRead(
    ptyId: string,
    currentFrame: boolean,
    load: (entry: ProviderVisibleRead) => Promise<RuntimeVisibleTerminalState | null>
  ): Promise<RuntimeVisibleTerminalState | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const grid = this.getTerminalSize(ptyId)
    const pending = this.providerVisibleStateReadsByPtyId.get(ptyId)
    if (
      pending?.generation === generation &&
      pending.currentFrame === currentFrame &&
      sameProviderFrameGrid(pending.grid, grid)
    ) {
      return pending.promise
    }
    const entry: ProviderVisibleRead = {
      generation,
      grid,
      currentFrame,
      promise: Promise.resolve(null)
    }
    this.providerVisibleStateReadsByPtyId.set(ptyId, entry)
    entry.promise = load(entry).finally(() => {
      if (this.providerVisibleStateReadsByPtyId.get(ptyId) === entry) {
        this.providerVisibleStateReadsByPtyId.delete(ptyId)
      }
    })
    return entry.promise
  }

  protected async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: {
      timeoutMs?: number
      retireOnTimeout?: boolean
      currentFrame?: boolean
      visible?: boolean
      visibleScreenOnly?: boolean
    } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    return (await this.awaitProviderTerminalBuffer(ptyId, opts, wait)).snapshot
  }

  /** `late` is the capture still running when the bounded wait gave up, so a caller can act once it lands. */
  protected async awaitProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: {
      timeoutMs?: number
      retireOnTimeout?: boolean
      currentFrame?: boolean
      visible?: boolean
      visibleScreenOnly?: boolean
    } = {}
  ): Promise<ProviderTerminalBufferWait> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
    const acquisitions = wait.currentFrame
      ? this.providerFrameAcquisitionsByPtyId
      : this.providerBufferAcquisitionsByPtyId
    // A current frame joins only one taken for the PTY's present grid.
    const grid = wait.currentFrame ? this.getTerminalSize(ptyId) : undefined
    let acquisition = acquisitions.get(ptyId)
    // A visible read never inherits an ordinary acquisition a grid change retired; it takes its own,
    // owned by its visible-read entry, and leaves the shared one to deep history.
    const retiredForVisible =
      (wait.visible === true || wait.visibleScreenOnly === true) &&
      acquisition?.visibleRetired === true
    const current =
      !retiredForVisible &&
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
      if (!retiredForVisible) {
        acquisitions.set(ptyId, acquisition)
        void promise.finally(() => {
          if (acquisitions.get(ptyId) === acquisition) {
            acquisitions.delete(ptyId)
          }
        })
      }
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
