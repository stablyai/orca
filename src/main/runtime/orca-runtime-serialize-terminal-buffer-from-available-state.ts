// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './orca-runtime-create-pty-headless-terminal-state'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import { withTimeout } from './runtime-async-boundaries'
import { TrailingTerminalOutputCapture } from './terminal-output-trailing-capture'

type ReframeSource = {
  data: string
  cols: number
  rows: number
  scrollbackAnsi?: string
  seq?: number
  cwd?: string | null
  oscLinks?: TerminalOscLinkRange[]
  kittyKeyboardFlags?: number
} | null

export class OrcaRuntimeWithSerializeTerminalBufferFromAvailableState extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
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
    // Why captured for the whole call: a reframe below seeds a fresh emulator
    // from a frame that is one round-trip old, and the bytes published in the
    // meantime are the only way to bring that emulator up to the live sequence.
    const trailing = new TrailingTerminalOutputCapture(this.getPtyOutputSequence(ptyId))
    const unsubscribe = this.subscribeToTerminalData(ptyId, (data, meta) =>
      trailing.push(data, meta)
    )
    try {
      return await this.serializeTerminalBufferAtPtyGrid(ptyId, opts, trailing)
    } finally {
      unsubscribe()
    }
  }

  private async serializeTerminalBufferAtPtyGrid(
    ptyId: string,
    opts: { scrollbackRows?: number },
    trailing: TrailingTerminalOutputCapture
  ): Promise<Awaited<ReturnType<this['serializeTerminalBufferFromAvailableState']>>> {
    // Why: while a remote-desktop viewer (a preview card, a phone) owns the
    // grid, the desktop pane's xterm is parked at a geometry that is no
    // longer the PTY's — the runtime drops its resizes by design. A snapshot
    // taken from it would hand the viewer the wrong grid and, with nothing
    // ever re-asking, leave it there. The headless emulator applyLayout
    // resizes is the only buffer that tracks the PTY; prefer it whenever the
    // renderer's frame does not match the PTY's size.
    const ptySize = this.getTerminalSize(ptyId)
    const rendererMatchesPty = (snapshot: { cols: number; rows: number } | null): boolean =>
      !ptySize || !snapshot || (snapshot.cols === ptySize.cols && snapshot.rows === ptySize.rows)
    // Why ensure here and not at the IPC site: every viewer path (the preview
    // dialog, a phone's subscribe) reaches this branch, so every one gets the
    // emulator main resizes with the claim — hydrated from the pane when its
    // serializer is registered, a frame-only emulator at the PTY grid when not.
    const serveAtPtyGrid = async (source: ReframeSource) => {
      if (!source) {
        return null
      }
      this.ensureHeadlessTerminalForViewer(ptyId)
      // Why: with the provider preference still set (and no renderer
      // hydration in flight), the emulator is a suffix-only model of restored
      // state. The full frame plus a contiguous trailing capture holds every
      // byte it does and more, so it is replaced; a capture with a hole would
      // lose bytes only the emulator has, so the emulator stays.
      const suffixOnlyModel =
        this.providerSnapshotPreferredPtys.has(ptyId) &&
        this.headlessHydrationState.get(ptyId) !== 'pending' &&
        trailing.after(source.seq) !== null
      return (
        (suffixOnlyModel ? null : await this.serializeHeadlessTerminalBuffer(ptyId, opts)) ??
        (await this.reframeSnapshotAtPtyGrid(ptyId, source, ptySize, opts, trailing))
      )
    }
    if (this.providerSnapshotPreferredPtys.has(ptyId)) {
      // Why: pre-attach stream bytes only form a suffix of restored state. A
      // sequenced provider snapshot safely reconciles live bytes; renderer is
      // the fallback when an older provider cannot expose that boundary.
      const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
      if (providerSnapshot && rendererMatchesPty(providerSnapshot)) {
        return providerSnapshot
      }
      if (providerSnapshot) {
        // Why: a session adopted from the daemon after a relaunch is served
        // from the daemon's own emulator, whose size can lag the grid a
        // viewer just claimed. Same rule as for the pane's frame: a layout
        // at another size is re-laid-out at the PTY's before it is served.
        return (await serveAtPtyGrid(providerSnapshot)) ?? providerSnapshot
      }
      const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
      if (rendererSnapshot && rendererMatchesPty(rendererSnapshot)) {
        return rendererSnapshot
      }
      const headlessSnapshot = await serveAtPtyGrid(rendererSnapshot)
      if (headlessSnapshot) {
        return headlessSnapshot
      }
      if (rendererSnapshot) {
        return rendererSnapshot
      }
    }
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, opts)
    if (headlessSnapshot) {
      return headlessSnapshot
    }

    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    if (!rendererSnapshot) {
      return this.serializeProviderTerminalBuffer(ptyId, opts)
    }
    if (!rendererMatchesPty(rendererSnapshot)) {
      const reframed = await serveAtPtyGrid(rendererSnapshot)
      if (reframed) {
        return reframed
      }
    }
    if (rendererSnapshot.data.length > 0) {
      return rendererSnapshot
    }
    // Why: parked desktop panes register serializers before their xterm has
    // hydrated. Treat that empty shell as provisional so retained provider
    // history can restore mobile without forcing the desktop pane to mount.
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
    if (
      providerSnapshot &&
      (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
    ) {
      return providerSnapshot
    }
    // Why: an empty frame is still a frame with a grid. The unhydrated pane's
    // grid is its parked default, not the PTY's; a viewer that just claimed
    // the grid would build its terminal at the wrong size and then receive
    // live bytes laid out for the right one. Serve the empty emulator at the
    // PTY grid instead — the bytes that follow land where they belong.
    if (!rendererMatchesPty(rendererSnapshot)) {
      const emptyAtPtyGrid = await this.serializeHeadlessTerminalBuffer(ptyId, {
        ...opts,
        includeEmpty: true
      })
      if (emptyAtPtyGrid) {
        return emptyAtPtyGrid
      }
    }
    return rendererSnapshot
  }

  /**
   * A frame's content re-laid-out at the PTY's real grid. The source (the
   * parked pane's xterm, or the daemon's emulator for an adopted session) is
   * at a size that is not the PTY's, and the headless emulator has nothing
   * newer: restore at the source size, resize to the PTY grid, replay
   * the bytes published since the source's `seq`, and read it back. Same
   * shape as mobile's recovery reseed.
   */
  private async reframeSnapshotAtPtyGrid(
    ptyId: string,
    source: ReframeSource,
    ptySize: { cols: number; rows: number } | null,
    opts: { scrollbackRows?: number },
    trailing: TrailingTerminalOutputCapture
  ): Promise<
    Awaited<
      ReturnType<OrcaRuntimeWithCreatePtyHeadlessTerminalState['serializeHeadlessTerminalBuffer']>
    >
  > {
    if (!source || !ptySize) {
      return null
    }
    // Why both parts: an alt-screen source keeps its normal buffer beside the
    // frame, and the emulator must hold the history too or the viewer's
    // scroll-up lands on nothing.
    const data = `${source.scrollbackAnsi ?? ''}${source.data}`
    if (data.length === 0) {
      return null
    }
    // Why replacing is safe: the emulator here is either empty (its
    // serializer just returned null) or a suffix-only model whose every byte
    // is in the source frame or in the contiguous `trailing` replayed below.
    const trailingOutput = trailing.after(source.seq)
    this.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      ptyId,
      { ...source, data },
      trailingOutput ?? [],
      ptySize
    )
    const state = this.headlessTerminals.get(ptyId)
    if (state && typeof source.seq === 'number') {
      // Why the source's own seq, not the live one: the seed's content stops
      // at the source's boundary. Replayed chunks advance it on the chain; a
      // capture that could not prove contiguity leaves it there so the viewer
      // fills the hole from its own buffer instead of trusting the frame.
      state.outputSequence = source.seq
    }
    return this.serializeHeadlessTerminalBuffer(ptyId, opts)
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
          source: 'renderer' as const
        })
      : null
  }

  protected async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
    let acquisition = this.providerBufferAcquisitionsByPtyId.get(ptyId)
    if (acquisition?.generation === generation && acquisition.timedOut) {
      return null
    }
    if (
      !acquisition ||
      acquisition.generation !== generation ||
      acquisition.scrollbackRows < scrollbackRows
    ) {
      const promise = this.captureProviderTerminalBuffer(ptyId, opts, generation)
      acquisition = { generation, scrollbackRows, promise, timedOut: false }
      this.providerBufferAcquisitionsByPtyId.set(ptyId, acquisition)
      void promise.finally(() => {
        if (this.providerBufferAcquisitionsByPtyId.get(ptyId) === acquisition) {
          this.providerBufferAcquisitionsByPtyId.delete(ptyId)
        }
      })
    }
    if (acquisition.timedOut) {
      return null
    }
    if (typeof wait.timeoutMs !== 'number') {
      return acquisition.promise
    }
    const result = await withTimeout<
      { settled: true; value: PtyProviderBufferSnapshot | null } | { settled: false }
    >(
      acquisition.promise.then((value) => ({ settled: true as const, value })),
      wait.timeoutMs,
      { settled: false as const }
    )
    if (!result.settled) {
      if (wait.retireOnTimeout) {
        acquisition.timedOut = true
      }
      return null
    }
    return result.value
  }
}
