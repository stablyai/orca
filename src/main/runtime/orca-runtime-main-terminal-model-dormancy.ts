import { OrcaRuntimeWithSerializeHeadlessTerminalBuffer } from './orca-runtime-serialize-headless-terminal-buffer'
import { MainTerminalModelDormancy } from './main-terminal-model-dormancy'
import { DaemonQueryResponderDelegation } from './daemon-query-responder-delegation'
import {
  isDaemonQueryResponderConfirmed,
  isHiddenRendererPty,
  isHiddenRendererPtyViewGated,
  registerHiddenRendererPtyMarkListener,
  registerHiddenRendererPtyUnmarkListener,
  setHiddenDeliveryDaemonHandoff,
  setHiddenDeliveryModelHandoff
} from '../ipc/pty-hidden-delivery-gate'
import {
  isNativeWindowsConptyPty,
  isTerminalModelQueryAuthorityEnabled
} from './terminal-model-query-authority'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import type {
  RuntimeHeadlessTerminal,
  RuntimePtyWorktreeRecord
} from './runtime-terminal-state-records'
import { canAgentMainTerminalModelRest } from './main-terminal-model-agent-rest'
import type { PtyProviderBufferSnapshot } from '../providers/types'

// Why the mobile depth: no reader of main's model asks for more; full-depth restores of a PTY
// that went dormant come from the daemon instead (prefersProviderRecoverySnapshot).
const DORMANT_MODEL_SEED_SCROLLBACK_ROWS = MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
const DORMANT_MODEL_SEED_TIMEOUT_MS = 2_000

/** An in-process consumer of one PTY's output. A 'model' reader reads main's emulator, or
 *  relies on it answering the PTY's queries, so it keeps that emulator live. */
export type TerminalOutputReader = { kind: 'model' }

export class OrcaRuntimeWithMainTerminalModelDormancy extends OrcaRuntimeWithSerializeHeadlessTerminalBuffer {
  protected readonly daemonQueryResponderDelegation = this.createDaemonQueryResponderDelegation()
  protected readonly mainTerminalModelDormancy = this.createMainTerminalModelDormancy()
  // Why: only the alt-screen tracker dormancy installed is retired when the model returns.
  private readonly dormantModeTrackers = new WeakSet<TerminalKittyKeyboardModeTracker>()

  /** Per chunk in onPtyData, before reply ownership is captured; true when main skips its model. */
  protected syncMainTerminalModelDemand(ptyId: string, chunkStartSeq: number): boolean {
    const skipModel = this.mainTerminalModelDormancy.onChunk(ptyId, chunkStartSeq)
    // Why after: a rebuild that caught up on this chunk lets a pending take-back go now.
    this.daemonQueryResponderDelegation.sync(ptyId)
    return skipModel
  }

  /** The daemon's in-order responder marker; the delivery gate has already applied it. */
  noteDaemonQueryResponderMarker(ptyId: string, responder: boolean): void {
    this.daemonQueryResponderDelegation.noteMarker(ptyId, responder)
  }

  /** Remote view presence changed: an attached remote view answers, so the daemon must stop. */
  protected syncDaemonQueryResponder(ptyId: string): void {
    this.daemonQueryResponderDelegation.sync(ptyId)
  }

  protected noteMainTerminalModelDemand(ptyId: string): void {
    this.mainTerminalModelDormancy.noteDemand(ptyId)
  }

  /** Registers a reader of this PTY's output; call the returned release when it stops reading. */
  acquireTerminalOutputReader(ptyId: string, reader: TerminalOutputReader): () => void {
    switch (reader.kind) {
      case 'model': {
        const release = this.mainTerminalModelDormancy.pin(ptyId)
        // Why: the reader may rely on main answering, so the daemon gives that role back now.
        this.daemonQueryResponderDelegation.sync(ptyId)
        return release
      }
    }
  }

  isMainTerminalModelDormant(ptyId: string): boolean {
    return this.mainTerminalModelDormancy.isDormant(ptyId)
  }

  /** Whether main's model is dormant or still being rebuilt, so it does not show the screen yet. */
  isMainTerminalModelCatchingUp(ptyId: string): boolean {
    return !this.mainTerminalModelDormancy.isCaughtUp(ptyId)
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
    // Why: the hide mark is the moment main may become the query responder, unless the
    // daemon takes that role.
    registerHiddenRendererPtyMarkListener((ptyId) => {
      this.daemonQueryResponderDelegation.sync(ptyId)
      if (!this.daemonQueryResponderDelegation.isRequested(ptyId)) {
        dormancy.noteDemand(ptyId)
      }
    })
    registerHiddenRendererPtyUnmarkListener((ptyId) =>
      this.daemonQueryResponderDelegation.sync(ptyId)
    )
    return dormancy
  }

  private createDaemonQueryResponderDelegation(): DaemonQueryResponderDelegation {
    return new DaemonQueryResponderDelegation({
      lifecycleGeneration: (ptyId) => this.getPtyLifecycleGeneration(ptyId),
      isHidden: isHiddenRendererPty,
      shouldDelegate: (ptyId) => this.shouldDelegateDaemonQueryResponder(ptyId),
      send: (ptyId, responder) =>
        this.ptyController?.setDaemonQueryResponder?.(ptyId, responder, {
          nativeWindowsConpty: isNativeWindowsConptyPty(ptyId)
        }) === true,
      // Why dormant only: a live model answers until the daemon confirms, so the view stays gated.
      setHandoffPending: (ptyId, pending) =>
        setHiddenDeliveryDaemonHandoff(
          ptyId,
          pending && this.mainTerminalModelDormancy.isDormant(ptyId)
        ),
      reclaim: (ptyId) => {
        this.mainTerminalModelDormancy.noteDemand(ptyId)
        return (
          this.hasRemoteTerminalViewSubscriber(ptyId) ||
          this.mainTerminalModelDormancy.isCaughtUp(ptyId)
        )
      }
    })
  }

  // Why the dormancy rules: delegating only pays off when main's model may then rest.
  private shouldDelegateDaemonQueryResponder(ptyId: string): boolean {
    const settings = this.store?.getSettings()
    return (
      settings?.terminalDaemonQueryAuthority !== false &&
      isTerminalModelQueryAuthorityEnabled(settings) &&
      isHiddenRendererPty(ptyId) &&
      !this.hasRemoteTerminalViewSubscriber(ptyId) &&
      !this.mainTerminalModelDormancy.hasReaders(ptyId) &&
      this.canMainTerminalModelRest(ptyId) &&
      this.ptyController?.canDelegateDaemonQueryResponder?.(ptyId) === true
    )
  }

  private isMainTerminalModelIdle(ptyId: string, ingestedSeq: number): boolean {
    const settings = this.store?.getSettings()
    // Why each: main answers a view-gated PTY's queries (sidecar-only ones included) unless the
    // daemon confirmed it does, and a model being rebuilt must finish first.
    if (
      !this.canMainTerminalModelRest(ptyId) ||
      (isHiddenRendererPtyViewGated(ptyId, settings) && !isDaemonQueryResponderConfirmed(ptyId)) ||
      this.providerSnapshotPreferredPtys.has(ptyId) ||
      this.headlessHydrationState.get(ptyId) === 'pending'
    ) {
      return false
    }
    const state = this.headlessTerminals.get(ptyId)
    return !state || state.outputSequence === ingestedSeq
  }

  private canMainTerminalModelRest(ptyId: string): boolean {
    const pty = this.ptysById.get(ptyId)
    if (
      this.store?.getSettings()?.terminalMainModelDormancy === false ||
      !pty ||
      pty.connectionId ||
      !this.canAgentPaneMainTerminalModelRest(ptyId, pty)
    ) {
      return false
    }
    // Why each: a viewer reads main's model, and only a mounted renderer parses the bytes for
    // display.
    return !(
      this.terminalViewSubscribers.hasRaw(ptyId) ||
      this.ptyController?.hasRendererSerializer?.(ptyId) !== true ||
      this.ptyController.canProvideSettledBufferSnapshot?.(ptyId) !== true
    )
  }

  // Why: agent signals without an identified agent fall to the unknown-pane rules, which read
  // the screen.
  private canAgentPaneMainTerminalModelRest(ptyId: string, pty: RuntimePtyWorktreeRecord): boolean {
    const agent = this.getPaneAgentForTuiIdle(ptyId)
    if (agent) {
      return canAgentMainTerminalModelRest(agent)
    }
    return !(
      pty.launchAgent ||
      pty.foregroundAgent ||
      pty.lastExplicitAgentStatus ||
      this.leavesByPtyId.get(ptyId)?.some((leaf) => leaf.lastAgentStatus != null)
    )
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
