// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCaptureProviderTerminalBuffer } from './orca-runtime-capture-provider-terminal-buffer'
import type { RuntimeTerminalProjection } from './orca-runtime-core'
import { buildPreview } from './terminal-tail-state'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'
import {
  VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from './orca-runtime-postlude'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  classifyTerminalScreenReadiness,
  type TerminalScreenReadiness
} from './terminal-screen-readiness'
import { withTimeout } from './runtime-async-boundaries'

export class OrcaRuntimeWithVisibleSnapshotPreview extends OrcaRuntimeWithCaptureProviderTerminalBuffer {
  protected getTerminalScreenReadiness(
    ptyId: string | null | undefined,
    retainedText: string
  ): TerminalScreenReadiness | null {
    const agent = this.getPaneAgentForTuiIdle(ptyId)
    if (
      !ptyId ||
      (agent ? agent !== 'antigravity' : !retainedText.toLowerCase().includes('antigravity cli'))
    ) {
      return null
    }
    const cached = this.providerVisibleStateByPtyId.get(ptyId)
    if (
      cached?.generation === this.getPtyLifecycleGeneration(ptyId) &&
      cached.sequence >= this.getPtyOutputSequence(ptyId) &&
      (!cached.headlessWriteChain ||
        cached.headlessWriteChain === this.headlessTerminals.get(ptyId)?.writeChain)
    ) {
      return classifyTerminalScreenReadiness({ tail: cached.lines, draft: cached.draft })
    }
    // A pending or unreachable screen cannot prove that typing is safe.
    void this.readVisibleTerminalState(ptyId).catch(() => {})
    return { ready: false, blockedReason: null }
  }

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
    const promise = this.loadVisibleTerminalState(ptyId)
      .then((state) => {
        if (
          state &&
          state.generation === this.getPtyLifecycleGeneration(ptyId) &&
          state.sequence >= this.getPtyOutputSequence(ptyId)
        ) {
          this.providerVisibleStateByPtyId.set(ptyId, state)
        }
        return state
      })
      .finally(() => {
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

    const generation = this.getPtyLifecycleGeneration(ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const cached = this.providerVisibleStateByPtyId.get(ptyId)
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    if (
      cached?.generation === generation &&
      outputSequence <= cached.sequence &&
      (!cached.headlessWriteChain ||
        cached.headlessWriteChain === this.headlessTerminals.get(ptyId)?.writeChain) &&
      (!trackedMode || trackedMode.isAlternateScreen === cached.isAlternateScreen)
    ) {
      return cached
    }
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
      generation
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
    const writeChain = state.writeChain
    await writeChain
    if (
      this.headlessTerminals.get(ptyId) !== state ||
      state.writeChain !== writeChain ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return null
    }
    return {
      ...projectTerminalVisibleLines(state.emulator),
      headlessWriteChain: writeChain,
      isAlternateScreen: state.emulator.isAlternateScreen,
      sequence: state.outputSequence,
      generation
    }
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
      // Why: raw PTY tails can be whitespace-only while a full-screen TUI is
      // visibly nonblank in renderer xterm. Ask the renderer for the active
      // screen instead of reusing the headless transcript path.
      const snapshot = await withTimeout(
        controller.serializeBuffer(ptyId, { scrollbackRows: 0 }),
        VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
        null
      )
      if (!snapshot || snapshot.data.length === 0) {
        return { lines: [] }
      }
      return this.parseVisibleSnapshot(snapshot)
    } catch {
      return { lines: [] }
    }
  }
}
