import { OrcaRuntimeWithProviderVisibleRead } from './provider-visible-read'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../wait/terminal-interactive-probe-budget'
import type { RuntimeTerminalProjection } from './terminal-projection'
import { buildPreview } from './tail/terminal-tail-state'
import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from '../records/runtime-terminal-state-records'
import { VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './provider-snapshot-budget'
import { projectTerminalVisibleLines } from '../view/orca-runtime-terminal-projection'
import { visibleNonBlankTerminalLines } from './tail/terminal-tail-read'
import type { RuledScreen } from '../wait/screen-input-veto'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import {
  providerFrameFitsGrid,
  type ProviderVisibleRead
} from '../lifecycle/terminal-view-resources'

export abstract class OrcaRuntimeWithVisibleSnapshotPreview extends OrcaRuntimeWithProviderVisibleRead {
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
    // The renderer continuation is held on the same read from before its primary to its return.
    return this.withProviderVisibleRead(ptyId, false, async (entry) => {
      const visibleState = await this.readVisibleTerminalState(ptyId, { entry })
      if (!knownAlternateScreen && !visibleState?.isAlternateScreen) {
        return preview
      }
      let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
      if (projection.lines.length === 0) {
        projection = await this.readRendererVisibleSnapshotLines(ptyId, entry)
      }
      return projection.lines.length > 0 ? buildPreview(projection.lines, '') : preview
    })
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

  /**
   * A renderer fallback for one visible read; its rows return only while that read is still current.
   * A supplied `timeoutMs` is the caller's remaining budget for the RPC, parse and return together.
   */
  protected readRendererVisibleSnapshotLines(
    ptyId: string,
    entry: ProviderVisibleRead,
    timeoutMs?: number
  ): Promise<RuntimeTerminalProjection> {
    const read = this.readRendererVisibleFrame(ptyId, entry)
    return timeoutMs === undefined ? read : withTimeout(read, timeoutMs, { lines: [] })
  }

  private async readRendererVisibleFrame(
    ptyId: string,
    entry: ProviderVisibleRead
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
      if (
        !snapshot ||
        snapshot.data.length === 0 ||
        !this.rendererFrameApplies(ptyId, entry, snapshot)
      ) {
        return { lines: [] }
      }
      const projection = await this.parseVisibleSnapshot(snapshot)
      return this.rendererFrameApplies(ptyId, entry, snapshot) ? projection : { lines: [] }
    } catch {
      return { lines: [] }
    }
  }

  private rendererFrameApplies(
    ptyId: string,
    entry: ProviderVisibleRead,
    snapshot: { cols: number; rows: number; seq?: number }
  ): boolean {
    return (
      this.ownsProviderVisibleRead(ptyId, entry) &&
      providerFrameFitsGrid(this.getTerminalSize(ptyId), entry.grid, snapshot) &&
      (snapshot.seq === undefined || this.getPtyOutputSequence(ptyId) <= snapshot.seq)
    )
  }
}
