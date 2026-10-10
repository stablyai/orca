import { OrcaRuntimeWithSerializeHeadlessTerminalBuffer } from './orca-runtime-serialize-headless-terminal-buffer'
import { MainTerminalModelDormancy } from './main-terminal-model-dormancy'
import {
  isHiddenRendererPtyViewGated,
  registerHiddenRendererPtyMarkListener,
  setHiddenDeliveryModelHandoff
} from '../ipc/pty-hidden-delivery-gate'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../providers/types'

// Why the mobile depth: no reader of main's model asks for more; full-depth restores of a PTY
// that went dormant come from the daemon instead (prefersProviderRecoverySnapshot).
const DORMANT_MODEL_SEED_SCROLLBACK_ROWS = MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
const DORMANT_MODEL_SEED_TIMEOUT_MS = 2_000

/** An in-process consumer of one PTY's output. A 'model' reader reads main's emulator, or
 *  relies on it answering the PTY's queries, so it keeps that emulator live. */
export type TerminalOutputReader = { kind: 'model' }

export class OrcaRuntimeWithMainTerminalModelDormancy extends OrcaRuntimeWithSerializeHeadlessTerminalBuffer {
  protected readonly mainTerminalModelDormancy = this.createMainTerminalModelDormancy()
  // Why: only the alt-screen tracker dormancy installed is retired when the model returns.
  private readonly dormantModeTrackers = new WeakSet<TerminalKittyKeyboardModeTracker>()

  /** Per chunk in onPtyData, before reply ownership is captured; true when main skips its model. */
  protected syncMainTerminalModelDemand(ptyId: string, chunkStartSeq: number): boolean {
    return this.mainTerminalModelDormancy.onChunk(ptyId, chunkStartSeq)
  }

  protected noteMainTerminalModelDemand(ptyId: string): void {
    this.mainTerminalModelDormancy.noteDemand(ptyId)
  }

  /** Registers a reader of this PTY's output; call the returned release when it stops reading. */
  acquireTerminalOutputReader(ptyId: string, reader: TerminalOutputReader): () => void {
    switch (reader.kind) {
      case 'model':
        return this.mainTerminalModelDormancy.pin(ptyId)
    }
  }

  isMainTerminalModelDormant(ptyId: string): boolean {
    return this.mainTerminalModelDormancy.isDormant(ptyId)
  }

  /** A model rebuilt after dormancy holds only a bounded seed, so full-depth hidden-output
   *  recovery must come from the daemon, like after a keep-tail data gap. */
  prefersProviderRecoverySnapshot(ptyId: string): boolean {
    return this.mainTerminalModelDormancy.wasEverDormant(ptyId)
  }

  /** The daemon's snapshot rebased into main's seq domain; null lets recovery fall back to main. */
  serializeProviderRecoveryBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    return this.serializeProviderTerminalBuffer(ptyId, opts)
  }

  private createMainTerminalModelDormancy(): MainTerminalModelDormancy {
    const dormancy = new MainTerminalModelDormancy({
      now: () => Date.now(),
      lifecycleGeneration: (ptyId) => this.getPtyLifecycleGeneration(ptyId),
      outputSequence: (ptyId) => this.getPtyOutputSequence(ptyId),
      isModelIdle: (ptyId, ingestedSeq) => this.isMainTerminalModelIdle(ptyId, ingestedSeq),
      dropModel: (ptyId) => this.dropMainTerminalModel(ptyId),
      materializeModel: (ptyId) => this.materializeDormantMainTerminalModel(ptyId),
      setHandoffPending: setHiddenDeliveryModelHandoff
    })
    // Why: the hide mark is the moment main may become the query responder.
    registerHiddenRendererPtyMarkListener((ptyId) => dormancy.noteDemand(ptyId))
    return dormancy
  }

  private isMainTerminalModelIdle(ptyId: string, ingestedSeq: number): boolean {
    const settings = this.store?.getSettings()
    const pty = this.ptysById.get(ptyId)
    if (
      settings?.terminalMainModelDormancy === false ||
      !pty ||
      pty.connectionId ||
      pty.launchAgent ||
      pty.foregroundAgent ||
      pty.lastExplicitAgentStatus
    ) {
      return false
    }
    // Why each: main answers a view-gated PTY's queries (sidecar-only ones included), a
    // viewer or an agent's screen rules read main's model, and only a mounted renderer
    // parses the bytes for display.
    if (
      isHiddenRendererPtyViewGated(ptyId, settings) ||
      this.terminalViewSubscribers.hasRaw(ptyId) ||
      this.providerSnapshotPreferredPtys.has(ptyId) ||
      this.headlessHydrationState.get(ptyId) === 'pending' ||
      this.leavesByPtyId.get(ptyId)?.some((leaf) => leaf.lastAgentStatus != null) ||
      this.ptyController?.hasRendererSerializer?.(ptyId) !== true ||
      this.ptyController.canProvideSettledBufferSnapshot?.(ptyId) !== true
    ) {
      return false
    }
    const state = this.headlessTerminals.get(ptyId)
    return !state || state.outputSequence === ingestedSeq
  }

  private dropMainTerminalModel(ptyId: string): void {
    const tracker = new TerminalKittyKeyboardModeTracker()
    // Why: isTerminalAlternateScreen falls back to this tracker while main holds no model.
    tracker.scan(this.isTerminalAlternateScreen(ptyId) ? '\x1b[?1049h' : '\x1b[?1049l')
    this.providerModeTrackersByPtyId.set(ptyId, tracker)
    this.dormantModeTrackers.add(tracker)
    this.disposeHeadlessTerminal(ptyId)
  }

  private materializeDormantMainTerminalModel(ptyId: string): void {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const ingestedAtWake = this.getPtyOutputSequence(ptyId)
    const state = this.createPtyHeadlessTerminalState(
      ptyId,
      this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    )
    state.outputSequence = ingestedAtWake
    this.headlessTerminals.set(ptyId, state)
    // Why both: readers use the daemon's snapshot, and renderer hydration stays away, until the seed lands.
    this.providerSnapshotPreferredPtys.add(ptyId)
    this.headlessHydrationState.set(ptyId, 'pending')
    const owns = (): boolean =>
      this.headlessTerminals.get(ptyId) === state &&
      this.getPtyLifecycleGeneration(ptyId) === generation
    state.writeChain = state.writeChain.then(async () => {
      const seedSeq = await this.seedDormantModelFromProvider(ptyId, state, ingestedAtWake, owns)
      if (!owns()) {
        this.mainTerminalModelDormancy.seedFailed(ptyId)
        return
      }
      if (seedSeq === null) {
        // Why: the model is a partial suffix; the provider-preferred path replaces it from the
        // renderer on the next byte, as for any PTY whose history arrived late.
        this.headlessHydrationState.delete(ptyId)
        this.mainTerminalModelDormancy.seedFailed(ptyId)
        return
      }
      this.headlessHydrationState.set(ptyId, 'done')
      this.providerSnapshotPreferredPtys.delete(ptyId)
      const tracker = this.providerModeTrackersByPtyId.get(ptyId)
      if (tracker && this.dormantModeTrackers.has(tracker)) {
        this.providerModeTrackersByPtyId.delete(ptyId)
      }
      this.mainTerminalModelDormancy.seedSettled(ptyId, seedSeq)
    })
  }

  /** Writes the daemon's settled snapshot into a fresh model; returns its seq, or null when it
   *  cannot be used. Live chunks queued behind this skip what the seq covers. */
  private async seedDormantModelFromProvider(
    ptyId: string,
    state: RuntimeHeadlessTerminal,
    ingestedAtWake: number,
    owns: () => boolean
  ): Promise<number | null> {
    try {
      const snapshot = await this.serializeProviderTerminalBuffer(
        ptyId,
        { scrollbackRows: DORMANT_MODEL_SEED_SCROLLBACK_ROWS },
        { timeoutMs: DORMANT_MODEL_SEED_TIMEOUT_MS }
      )
      // Why: a snapshot behind bytes main already ingested would need them replayed, and a
      // dormant main kept none.
      if (!owns() || !snapshot || snapshot.seq < ingestedAtWake) {
        return null
      }
      const { emulator } = state
      const grid = emulator.getAppliedSize()
      if (grid.cols !== snapshot.cols || grid.rows !== snapshot.rows) {
        emulator.resize(snapshot.cols, snapshot.rows)
      }
      // Why no forwardQueryReplies: queries inside a snapshot were answered long ago.
      await emulator.write(`${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`)
      if (typeof snapshot.kittyKeyboardFlags === 'number') {
        await emulator.applyKittyKeyboardFlags(snapshot.kittyKeyboardFlags)
      }
      // Why last: the next live chunk completes this dangling escape.
      if (snapshot.pendingEscapeTailAnsi) {
        await emulator.write(snapshot.pendingEscapeTailAnsi)
      }
      const ptyGrid = this.getTerminalSize(ptyId)
      if (ptyGrid && (ptyGrid.cols !== snapshot.cols || ptyGrid.rows !== snapshot.rows)) {
        emulator.resize(ptyGrid.cols, ptyGrid.rows)
      }
      if (snapshot.cwd !== undefined) {
        emulator.setCwd(snapshot.cwd)
      }
      if (snapshot.oscLinks !== undefined) {
        emulator.setRestoredOscLinks(snapshot.oscLinks)
      }
      if (snapshot.lastTitle) {
        emulator.setLastTitle(snapshot.lastTitle)
      }
      state.ownership.seedOwner(snapshot.terminalOwner, {
        alternateScreen: emulator.isAlternateScreen
      })
      state.seedCoverageSeq = snapshot.seq
      state.outputSequence = Math.max(state.outputSequence, snapshot.seq)
      return owns() ? snapshot.seq : null
    } catch {
      return null
    }
  }
}
