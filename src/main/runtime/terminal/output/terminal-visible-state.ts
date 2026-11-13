import { OrcaRuntimeWithCaptureProviderTerminalBuffer } from './provider-buffer-capture'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../wait/terminal-interactive-probe-budget'
import type { RuntimeTerminalProjection } from './terminal-projection'
import { buildPreview } from './tail/terminal-tail-state'
import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from '../records/runtime-terminal-state-records'
import {
  VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from './provider-snapshot-budget'
import { projectTerminalVisibleLines } from '../view/orca-runtime-terminal-projection'
import { visibleNonBlankTerminalLines } from './tail/terminal-tail-read'
import type { RuledScreen } from '../wait/screen-input-veto'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import {
  providerFrameFitsGrid,
  type ProviderVisibleRead
} from '../lifecycle/terminal-view-resources'

export abstract class OrcaRuntimeWithVisibleSnapshotPreview extends OrcaRuntimeWithCaptureProviderTerminalBuffer {
  protected async visibleSnapshotPreview(ptyId: string, preview: string): Promise<string> {
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
    if (this.hasHostHistoryAuthority(ptyId)) {
      // Only the daemon's current frame may replace the summary; otherwise keep the summary.
      const frame =
        knownAlternateScreen || this.headlessTerminals.has(ptyId)
          ? await this.readHostCurrentFrame(ptyId)
          : null
      return frame?.isAlternateScreen && frame.lines.length > 0
        ? buildPreview(frame.lines, '')
        : preview
    }
    const providerModeUnknown =
      this.providerSnapshotPreferredPtys.has(ptyId) && !this.providerModeTrackersByPtyId.has(ptyId)
    if (!providerModeUnknown && !knownAlternateScreen && !this.headlessTerminals.has(ptyId)) {
      return preview
    }
    const visibleState = await this.readVisibleTerminalState(ptyId)
    if (!knownAlternateScreen && !visibleState?.isAlternateScreen) {
      return preview
    }
    let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
    if (projection.lines.length === 0) {
      projection = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    return projection.lines.length > 0 ? buildPreview(projection.lines, '') : preview
  }

  protected readVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null> {
    return this.ownProviderVisibleRead(ptyId, false, (entry) =>
      this.loadVisibleTerminalState(ptyId, entry)
    )
  }

  protected async loadVisibleTerminalState(
    ptyId: string,
    entry: ProviderVisibleRead
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      return this.readHeadlessVisibleTerminalState(ptyId)
    }

    const generation = this.getPtyLifecycleGeneration(ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const cached = this.readCurrentProviderVisibleState(ptyId)
    if (cached) {
      return cached
    }
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    if (trackedMode && !trackedMode.isAlternateScreen) {
      const headlessState = await this.readHeadlessVisibleTerminalState(ptyId)
      return headlessState
        ? { ...headlessState, isAlternateScreen: false }
        : {
            lines: [],
            isAlternateScreen: false,
            sequence: outputSequence,
            generation
          }
    }
    return this.captureProviderVisibleState(ptyId, entry)
  }

  /**
   * Public reads of a host-owned binding: the daemon's live scrollback-0 frame at the current
   * sequence. Private screen, input and status services keep reading main's projection.
   */
  protected readHostCurrentFrame(ptyId: string): Promise<RuntimeVisibleTerminalState | null> {
    return this.ownProviderVisibleRead(
      ptyId,
      true,
      async (entry) =>
        this.readCurrentProviderVisibleState(ptyId, true) ??
        this.captureProviderVisibleState(ptyId, entry)
    )
  }

  /** The provider's last frame of this kind while no later output, mode switch or resize has outdated it. */
  protected readCurrentProviderVisibleState(
    ptyId: string,
    currentFrame = false
  ): RuntimeVisibleTerminalState | null {
    const cached = this.providerVisibleStateByPtyId.get(ptyId)
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    return cached?.state.generation === this.getPtyLifecycleGeneration(ptyId) &&
      cached.currentFrame === currentFrame &&
      this.getPtyOutputSequence(ptyId) <= cached.state.sequence &&
      (!trackedMode || trackedMode.isAlternateScreen === cached.state.isAlternateScreen) &&
      providerFrameFitsGrid(this.getTerminalSize(ptyId), undefined, cached.grid)
      ? cached.state
      : null
  }

  /**
   * Asks the provider for its current frame and caches it; null while it cannot give one now.
   * Without an owning read entry (a restored-dialog probe) it takes one of its own.
   */
  protected async captureProviderVisibleState(
    ptyId: string,
    owner?: ProviderVisibleRead
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (!owner) {
      return this.ownProviderVisibleRead(ptyId, false, (entry) =>
        this.captureProviderVisibleState(ptyId, entry)
      )
    }
    // Ownership is the exact entry of the current lifecycle; a retired one writes nothing.
    const generation = owner.generation
    const owns = (): boolean =>
      this.providerVisibleStateReadsByPtyId.get(ptyId) === owner &&
      this.getPtyLifecycleGeneration(ptyId) === generation
    if ((this.providerVisibleRetryAtByPtyId.get(ptyId) ?? 0) > Date.now()) {
      return null
    }

    const snapshot = await this.serializeProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: 0 },
      {
        timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
        ...(owner.currentFrame ? { currentFrame: true } : { visible: true })
      }
    )
    if (!owns()) {
      return null
    }
    if (!snapshot) {
      this.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
      return null
    }
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    if (
      this.providerSnapshotsWithLiveModeTransition.has(snapshot) &&
      !this.hasHostHistoryAuthority(ptyId)
    ) {
      // Why: the provider frame can predate a mode switch observed while its
      // RPC was pending; the ordered live emulator owns the post-switch grid.
      const liveState = await this.readHeadlessVisibleTerminalState(ptyId)
      if (!owns()) {
        return null
      }
      if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
        return liveState
      }
    }
    const projection = await this.parseVisibleSnapshot(snapshot)
    const frameGrid = { cols: snapshot.cols, rows: snapshot.rows }
    if (
      !owns() ||
      this.getPtyOutputSequence(ptyId) > snapshot.seq ||
      !providerFrameFitsGrid(this.getTerminalSize(ptyId), owner.grid, frameGrid)
    ) {
      return null
    }
    const visibleState: RuntimeVisibleTerminalState = {
      ...projection,
      isAlternateScreen: snapshot.alternateScreen ?? false,
      sequence: snapshot.seq,
      generation
    }
    this.providerVisibleStateByPtyId.set(ptyId, {
      state: visibleState,
      grid: frameGrid,
      currentFrame: owner.currentFrame
    })
    return visibleState
  }

  protected async readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return null
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    await state.writeChain
    if (
      this.headlessTerminals.get(ptyId) !== state ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return null
    }
    return {
      ...projectTerminalVisibleLines(state.emulator),
      isAlternateScreen: state.emulator.isAlternateScreen,
      sequence: state.outputSequence,
      generation
    }
  }

  protected async readCurrentTerminalWaitScreen(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null | undefined> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const screen = await withTimeout(
      this.readVisibleTerminalState(ptyId),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
      null
    )
    if (generation !== this.getPtyLifecycleGeneration(ptyId)) {
      return undefined
    }
    return screen &&
      screen.generation === generation &&
      screen.sequence >= this.getPtyOutputSequence(ptyId)
      ? screen
      : null
  }

  /** Synchronous visible grid of the live emulator, for tui-idle body evidence. Null when the
   *  model is not the whole screen: a provider-restored partial suffix or a pending hydration. */
  protected readLiveTerminalScreenLines(ptyId: string | null | undefined): string[] | null {
    const state = this.readWholeScreenModel(ptyId)
    // Why unawaited writeChain: callers are synchronous; a grid one chunk behind is re-read next poll.
    return state ? projectTerminalVisibleLines(state.emulator).lines : null
  }

  /** The ruled grid only once it has applied every PTY chunk; a lagging grid could miss a new dialog. */
  protected readCaughtUpRuledScreen(ptyId: string): RuledScreen | null {
    return this.headlessTerminals.get(ptyId)?.outputSequence === this.getPtyOutputSequence(ptyId)
      ? this.readRuledScreen(ptyId)
      : null
  }

  /** The grid a screen-ruled agent's rule reads: as painted, and only on the PTY's own size. */
  protected readRuledScreen(ptyId: string | null | undefined): RuledScreen | null {
    const state = this.readWholeScreenModel(ptyId)
    if (!ptyId || !state || state.unrepaintedReflowGrid !== undefined) {
      return null
    }
    // Why: a TUI painted for another grid garbles on this one, and a screen rule would refuse it.
    const ptySize = this.getTerminalSize(ptyId)
    const grid = state.emulator.getAppliedSize()
    if (!ptySize || ptySize.cols !== grid.cols || ptySize.rows !== grid.rows) {
      return null
    }
    // Why raw rows, not the read projection: it blanks a composer it takes for a draft, and Cline's
    // placeholder reads as one, so a typed draft and an empty composer would look the same.
    return {
      lines: visibleNonBlankTerminalLines(state.emulator.getVisibleLines()),
      alternateScreen: state.emulator.isAlternateScreen
    }
  }

  protected readWholeScreenModel(ptyId: string | null | undefined): RuntimeHeadlessTerminal | null {
    if (!ptyId) {
      return null
    }
    const state = this.headlessTerminals.get(ptyId)
    if (
      !state ||
      this.providerSnapshotPreferredPtys.has(ptyId) ||
      this.headlessHydrationState.get(ptyId) === 'pending'
    ) {
      return null
    }
    return state
  }

  protected async parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<RuntimeTerminalProjection> {
    if (snapshot.data.length === 0) {
      return { lines: [] }
    }
    const emulator = new HeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: 0
    })
    try {
      await emulator.write(`\x1b[2J\x1b[3J\x1b[H${snapshot.data}`)
      return projectTerminalVisibleLines(emulator)
    } finally {
      emulator.dispose()
    }
  }

  protected async readRendererVisibleSnapshotLines(
    ptyId: string
  ): Promise<RuntimeTerminalProjection> {
    const controller = this.ptyController
    if (!controller?.serializeBuffer) {
      return { lines: [] }
    }
    if (controller.hasRendererSerializer && !controller.hasRendererSerializer(ptyId)) {
      return { lines: [] }
    }
    try {
      // Raw tails can be blank while full-screen TUIs paint visible cells; ask renderer for the active screen.
      const snapshot = await withTimeout(
        controller.serializeBuffer(ptyId, { scrollbackRows: 0 }),
        VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
        null
      )
      if (!snapshot || snapshot.data.length === 0) {
        return { lines: [] }
      }
      return await this.parseVisibleSnapshot(snapshot)
    } catch {
      return { lines: [] }
    }
  }
}
