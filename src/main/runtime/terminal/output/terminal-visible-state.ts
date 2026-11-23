import { OrcaRuntimeWithCaptureProviderTerminalBuffer } from './provider-buffer-capture'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../wait/terminal-interactive-probe-budget'
import type { RuntimeTerminalProjection } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { buildPreview } from './tail/terminal-tail-state'
import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from '../records/runtime-terminal-state-records'
import {
  VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from './provider-snapshot-budget'
import { projectTerminalVisibleLines } from '../../../daemon/emulation/terminal-screen-projection'
import { visibleNonBlankTerminalLines } from './tail/terminal-tail-read'
import type { RuledScreen } from '../wait/screen-input-veto'
import { readScreenClearingBlockedTail } from '../wait/blocked-tail-screen-clear'
import { TUI_IDLE_QUIESCENCE_MS } from '../wait/terminal-idle-policy'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import { isHalfDrawnRecoveringFrame } from './gap-recovery-screen'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'

export abstract class OrcaRuntimeWithVisibleSnapshotPreview extends OrcaRuntimeWithCaptureProviderTerminalBuffer {
  /** `isStale` is true once the preview's source stops being trustworthy; check it right before use. */
  protected async visibleSnapshotPreview(
    ptyId: string,
    preview: string
  ): Promise<{ preview: string; isStale: () => boolean }> {
    const fresh = { preview, isStale: () => false }
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
    // A provider-owned screen tracked as normal previews its raw tail, as on main: only an alternate one needs a frame.
    if (
      this.providerSnapshotPreferredPtys.has(ptyId)
        ? this.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen === false
        : !knownAlternateScreen && !this.headlessTerminals.has(ptyId)
    ) {
      return fresh
    }
    const gaps = this.ptyGapCounts.get(ptyId)
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const model = this.headlessTerminals.get(ptyId)
    const visibleState = await this.readVisibleTerminalState(ptyId)
    if (!knownAlternateScreen && !visibleState?.isAlternateScreen) {
      return fresh
    }
    let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
    if (projection.lines.length === 0) {
      projection = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    if (projection.lines.length === 0) {
      return fresh
    }
    const { rendererToken } = projection
    return {
      preview: buildPreview(projection.lines, ''),
      isStale: () =>
        rendererToken !== undefined
          ? this.rendererScreenToken(ptyId) !== rendererToken
          : // A model or provider screen: a gap, a replaced model or a new lifecycle since the read makes it older.
            // A recovering model never answers the read, so a frame read during recovery is the provider's.
            this.headlessTerminals.get(ptyId) !== model ||
            this.ptyGapCounts.get(ptyId) !== gaps ||
            this.getPtyLifecycleGeneration(ptyId) !== generation
    }
  }

  protected async readVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const pending = this.providerVisibleStateReadsByPtyId.get(ptyId)
    if (pending?.generation === generation) {
      return pending.promise
    }
    let entry: { generation: number; promise: Promise<RuntimeVisibleTerminalState | null> }
    const promise = this.loadVisibleTerminalState(ptyId).finally(() => {
      if (this.providerVisibleStateReadsByPtyId.get(ptyId) === entry) {
        this.providerVisibleStateReadsByPtyId.delete(ptyId)
      }
    })
    entry = { generation, promise }
    this.providerVisibleStateReadsByPtyId.set(ptyId, entry)
    return promise
  }

  protected async loadVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      return this.readHeadlessVisibleTerminalState(ptyId)
    }
    // A recovering screen is unknown, never an empty frame; one the provider owned before the gap takes its frame below.
    const recovery = this.headlessTerminals.get(ptyId)?.gapReseed
    if (recovery?.providerOwnedBeforeGap === false) {
      return null
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const cached = this.readCurrentProviderVisibleState(ptyId)
    if (cached) {
      return cached
    }
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    if (trackedMode && !trackedMode.isAlternateScreen && !recovery) {
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
    return this.captureProviderVisibleState(ptyId)
  }

  /** The provider's last frame while no later output or mode switch has outdated it. */
  protected readCurrentProviderVisibleState(ptyId: string): RuntimeVisibleTerminalState | null {
    const cached = this.providerVisibleStateByPtyId.get(ptyId)
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    return cached?.generation === this.getPtyLifecycleGeneration(ptyId) &&
      this.getPtyOutputSequence(ptyId) <= cached.sequence &&
      (!trackedMode || trackedMode.isAlternateScreen === cached.isAlternateScreen)
      ? cached
      : null
  }

  /** Asks the provider for its current frame and caches it; null while it cannot give one now. */
  protected async captureProviderVisibleState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    if ((this.providerVisibleRetryAtByPtyId.get(ptyId) ?? 0) > Date.now()) {
      return null
    }

    const { snapshot, late } = await this.awaitProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: 0, visibleProjection: true },
      { timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS }
    )
    if (late && this.ptyLifecycleGenerationById.get(ptyId) === generation) {
      // Why: later reads must not re-await a slow capture; its frame lands in the cache instead.
      this.providerVisibleRetryAtByPtyId.set(ptyId, Number.POSITIVE_INFINITY)
      void late
        .then((landed) => {
          if (this.ptyLifecycleGenerationById.get(ptyId) !== generation) {
            return
          }
          return this.adoptProviderVisibleSnapshot(ptyId, generation, landed)
        })
        .catch(() => {})
      return null
    }
    return this.adoptProviderVisibleSnapshot(ptyId, generation, snapshot)
  }

  private async adoptProviderVisibleSnapshot(
    ptyId: string,
    generation: number,
    snapshot: PtyProviderBufferSnapshot | null
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (
      !snapshot ||
      this.getPtyLifecycleGeneration(ptyId) !== generation ||
      isHalfDrawnRecoveringFrame(this.headlessTerminals.get(ptyId), snapshot)
    ) {
      this.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
      return null
    }
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    if (this.providerSnapshotsWithLiveModeTransition.has(snapshot)) {
      // Why: the frame can predate a mode switch seen while its RPC was pending; the live emulator owns that grid.
      const liveState = await this.readHeadlessVisibleTerminalState(ptyId)
      if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
        return liveState
      }
    }
    const projection = snapshot.visibleProjection ?? (await this.parseVisibleSnapshot(snapshot))
    if (
      this.getPtyLifecycleGeneration(ptyId) !== generation ||
      this.getPtyOutputSequence(ptyId) > snapshot.seq
    ) {
      return null
    }
    const visibleState: RuntimeVisibleTerminalState = {
      ...projection,
      isAlternateScreen: snapshot.alternateScreen ?? false,
      sequence: snapshot.seq,
      generation
    }
    this.providerVisibleStateByPtyId.set(ptyId, visibleState)
    return visibleState
  }

  protected async readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const state = this.headlessTerminals.get(ptyId)
    // A model recovering from dropped output is no evidence of the screen.
    if (!state || state.gapReseed) {
      return null
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    await state.writeChain
    if (
      this.headlessTerminals.get(ptyId) !== state ||
      this.getPtyLifecycleGeneration(ptyId) !== generation ||
      state.gapReseed
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

  /** The settled screen when it proves the tail's blocked text a dialog erased in place (#24187). */
  protected readScreenClearingBlockedTailForPty(ptyId: string): string | null {
    return readScreenClearingBlockedTail({
      lastOutputAt: this.readOutputClockAt(ptyId),
      quiescenceMs: TUI_IDLE_QUIESCENCE_MS,
      agent: () => this.getPaneAgentForTuiIdle(ptyId),
      readScreen: () => this.readCaughtUpRuledScreen(ptyId),
      clearStamp: () => this.clearWaitBlockedStamp(ptyId)
    })
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
      state.gapReseed ||
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
}
