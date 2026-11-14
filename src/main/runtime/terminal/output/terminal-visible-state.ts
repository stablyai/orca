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
import {
  projectTerminalVisibleLines,
  restoreProjectedComposerDraft
} from '../view/orca-runtime-terminal-projection'
import { visibleNonBlankTerminalLines } from './tail/terminal-tail-read'
import type { RuledScreen } from '../wait/screen-input-veto'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'

export abstract class OrcaRuntimeWithVisibleSnapshotPreview extends OrcaRuntimeWithCaptureProviderTerminalBuffer {
  protected async visibleSnapshotPreview(ptyId: string, preview: string): Promise<string> {
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
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

    const cached = this.readCurrentProviderVisibleState(ptyId)
    if (cached) {
      return cached
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

    const snapshot = await this.serializeProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: 0 },
      { timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS }
    )
    if (!snapshot || this.getPtyLifecycleGeneration(ptyId) !== generation) {
      this.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
      return null
    }
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    if (this.providerSnapshotsWithLiveModeTransition.has(snapshot)) {
      // Why: the provider frame can predate a mode switch observed while its
      // RPC was pending; the ordered live emulator owns the post-switch grid.
      const liveState = await this.readHeadlessVisibleTerminalState(ptyId)
      if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
        return liveState
      }
    }
    const projection = await this.parseVisibleSnapshot(snapshot)
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
      generation,
      grid: { cols: snapshot.cols, rows: snapshot.rows }
    }
    this.providerVisibleStateByPtyId.set(ptyId, visibleState)
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
      ...projectTerminalVisibleLines(
        state.emulator,
        this.ptysById.get(ptyId)?.commandPaint?.contentOrigin
      ),
      isAlternateScreen: state.emulator.isAlternateScreen,
      sequence: state.outputSequence,
      generation,
      grid: state.emulator.getAppliedSize()
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
    return state
      ? projectTerminalVisibleLines(
          state.emulator,
          ptyId ? this.ptysById.get(ptyId)?.commandPaint?.contentOrigin : undefined
        ).lines
      : null
  }

  /** The ruled grid only once it has applied every PTY chunk; a lagging grid could miss a new dialog. */
  protected readCaughtUpRuledScreen(ptyId: string): RuledScreen | null {
    const local = this.readWholeScreenModel(ptyId)
    return this.readRuledScreen(
      ptyId,
      local?.outputSequence === this.getPtyOutputSequence(ptyId) ? local : null
    )
  }

  protected readCaughtUpProjectedScreen(ptyId: string): readonly string[] | null {
    const local = this.readWholeScreenModel(ptyId)
    return local?.outputSequence === this.getPtyOutputSequence(ptyId)
      ? projectTerminalVisibleLines(
          local.emulator,
          this.ptysById.get(ptyId)?.commandPaint?.contentOrigin
        ).lines
      : (this.readCurrentProviderVisibleState(ptyId)?.lines ?? null)
  }

  /** The grid a screen-ruled agent's rule reads: as painted, and only on the PTY's own size. */
  protected readRuledScreen(
    ptyId: string | null | undefined,
    state = this.readWholeScreenModel(ptyId)
  ): RuledScreen | null {
    if (!ptyId || this.headlessTerminals.get(ptyId)?.unrepaintedReflowGrid !== undefined) {
      return null
    }
    const provider = state ? null : this.readCurrentProviderVisibleState(ptyId)
    // Why: a TUI painted for another grid garbles on this one, and a screen rule would refuse it.
    const ptySize = this.getTerminalSize(ptyId) ?? provider?.grid
    const grid = state?.emulator.getAppliedSize() ?? provider?.grid
    if (!ptySize || !grid || ptySize.cols !== grid.cols || ptySize.rows !== grid.rows) {
      return null
    }
    // Why raw rows, not the read projection: it blanks a composer it takes for a draft, and Cline's
    // placeholder reads as one, so a typed draft and an empty composer would look the same.
    return state
      ? {
          lines: visibleNonBlankTerminalLines(
            this.ptysById.get(ptyId)?.commandPaint
              ? state.emulator.getVisibleActionLines(
                  this.ptysById.get(ptyId)!.commandPaint!.contentOrigin
                )
              : state.emulator.getVisibleLines()
          ),
          alternateScreen: state.emulator.isAlternateScreen
        }
      : provider
        ? {
            lines: restoreProjectedComposerDraft(provider.lines, provider.draft),
            alternateScreen: provider.isAlternateScreen
          }
        : null
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
