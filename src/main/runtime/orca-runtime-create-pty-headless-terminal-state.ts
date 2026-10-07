// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer } from './orca-runtime-maybe-hydrate-headless-from-renderer'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import type {
  HeadlessInlineImageConfiguration,
  HeadlessModelConfiguration
} from '../daemon/headless-model-checkpoint'
import {
  captureRuntimeHeadlessModel,
  publishRuntimeHeadlessModel,
  type RuntimeHeadlessModelCapture
} from './headless-terminal-model-checkpoint'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'
import { isNativeWindowsConptyPty } from './terminal-model-query-authority'
import { getTerminalViewAttributes } from './terminal-view-attribute-store'
import { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'
import { PROCESS_BOUNDARY_GROUND } from '../../shared/terminal-mode-reset-profiles'
import { readHeadlessImageReplacementConfiguration } from './headless-terminal-image-configuration'
import {
  readTerminalImageCellSize,
  type TerminalImageCellSize
} from '../../shared/terminal-image-cell-size'

export class OrcaRuntimeWithCreatePtyHeadlessTerminalState extends OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer {
  protected createPtyHeadlessEmulator(
    ptyId: string,
    configuration: HeadlessModelConfiguration,
    ownsModel: (model: HeadlessEmulator) => boolean
  ): HeadlessEmulator {
    const emulator = new HeadlessEmulator({
      ...configuration,
      onQueryReply: (reply) => {
        if (
          ownsModel(emulator) &&
          shouldForwardHeadlessTerminalQueryReply(this.ptysById.get(ptyId)?.launchAgent, reply)
        ) {
          this.ptyController?.write(ptyId, reply, 'query-reply')
        }
      }
    })
    if (isNativeWindowsConptyPty(ptyId)) {
      emulator.installConptyPrimaryDeviceAttributesOverride()
    }
    emulator.installViewAttributeResponder(() => getTerminalViewAttributes())
    const viewAttributes = getTerminalViewAttributes()
    if (viewAttributes) {
      emulator.applyPushedViewAttributes(viewAttributes)
    }
    return emulator
  }

  protected createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number },
    images?: HeadlessInlineImageConfiguration
  ): RuntimeHeadlessTerminal {
    let state: RuntimeHeadlessTerminal | null = null
    const pathFlavor = this.pathFlavorForPty(this.ptysById.get(ptyId))
    const emulator = this.createPtyHeadlessEmulator(
      ptyId,
      {
        ...dims,
        images,
        pathFlavor,
        remotePosixFileUriAuthority:
          !!this.ptysById.get(ptyId)?.connectionId && pathFlavor !== 'win32',
        wslDistro: this.ptysById.get(ptyId)?.connectionId
          ? undefined
          : (this.wslDistroByPtyId.get(ptyId) ?? this.ptysById.get(ptyId)?.wslDistro ?? undefined)
      },
      (model) =>
        state !== null && this.headlessTerminals.get(ptyId) === state && state.emulator === model
    )
    const constructed: RuntimeHeadlessTerminal = {
      emulator,
      outputSequence: 0,
      writeChain: Promise.resolve(),
      ownership: new PtyShellOwnershipMirror(async () => {
        const controller = this.ptyController
        const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
        if (
          !controller?.confirmShellForeground ||
          this.headlessTerminals.get(ptyId) !== constructed
        ) {
          return false
        }
        const confirmed = await controller.confirmShellForeground(ptyId)
        return (
          confirmed &&
          this.headlessTerminals.get(ptyId) === constructed &&
          this.getPtyLifecycleGeneration(ptyId) === lifecycleGeneration
        )
      })
    }
    state = constructed
    return state
  }

  captureHeadlessTerminalModelCheckpoint(
    ptyId: string,
    maxBytes: number
  ): Promise<RuntimeHeadlessModelCapture | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return Promise.resolve(null)
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnation = this.ptysById.get(ptyId)?.incarnationId
    const viewAttributes = getTerminalViewAttributes()
    return captureRuntimeHeadlessModel(
      state,
      maxBytes,
      () =>
        this.headlessTerminals.get(ptyId) === state &&
        this.getPtyLifecycleGeneration(ptyId) === generation &&
        this.ptysById.get(ptyId)?.incarnationId === incarnation &&
        getTerminalViewAttributes() === viewAttributes
    )
  }

  async restoreHeadlessTerminalModelCheckpoint(
    ptyId: string,
    capture: RuntimeHeadlessModelCapture
  ): Promise<void> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state || state !== capture.source) {
      throw new Error('Terminal model changed after capture')
    }
    const retired = await publishRuntimeHeadlessModel(
      state,
      capture,
      (configuration) =>
        this.createPtyHeadlessEmulator(
          ptyId,
          configuration,
          (model) => this.headlessTerminals.get(ptyId) === state && state.emulator === model
        ),
      () =>
        this.headlessTerminals.get(ptyId) === state &&
        this.getPtyOutputSequence(ptyId) === capture.outputSequence
    )
    retired.disableQueryReplyForwarding()
    retired.dispose()
  }

  /** Phase-5 ConPTY DA1 retrofit (terminal-query-authority.md): invoked via
   *  markNativeWindowsConptyPty when the spawn mark lands after daemon stream
   *  data already created this PTY's emulator. Idempotent emulator-side. */
  protected ensureNativeWindowsConptyDa1Override(ptyId: string): void {
    if (isNativeWindowsConptyPty(ptyId)) {
      this.headlessTerminals.get(ptyId)?.emulator.installConptyPrimaryDeviceAttributesOverride()
    }
  }

  protected getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal {
    const existing = this.headlessTerminals.get(ptyId)
    if (existing) {
      return existing
    }
    const size = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, size)
    this.headlessTerminals.set(ptyId, state)
    return state
  }

  protected replaceHeadlessTerminalAfterExecutionContextChange(ptyId: string): void {
    const images = readHeadlessImageReplacementConfiguration(
      this.headlessTerminals.get(ptyId),
      this.getPtyLifecycleGeneration(ptyId),
      this.ptysById.get(ptyId)?.incarnationId
    )
    this.disposeHeadlessTerminal(ptyId)
    this.providerSnapshotPreferredPtys.add(ptyId)
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims, images)
    this.headlessTerminals.set(ptyId, state)
    state.writeChain = state.writeChain
      .then(async () => {
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        const snapshot = await this.serializeProviderTerminalBuffer(ptyId)
        if (this.headlessTerminals.get(ptyId) !== state || !snapshot) {
          return
        }
        const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
        // Why: a newer live OSC 7 can arrive while the snapshot is in flight;
        // only seed metadata while no post-correction CWD has won the race.
        if (!this.terminalCwdByPtyId.has(ptyId)) {
          this.recordOsc7MetadataForPty(ptyId, data)
        }
        await state.emulator.write(data)
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        if (snapshot.cwd !== undefined) {
          state.emulator.setCwd(snapshot.cwd)
          if (!this.terminalCwdByPtyId.has(ptyId) && snapshot.cwd?.trim()) {
            this.terminalCwdByPtyId.set(ptyId, snapshot.cwd)
          }
        }
        if (snapshot.oscLinks !== undefined) {
          state.emulator.setRestoredOscLinks(snapshot.oscLinks)
        }
        state.ownership.seedOwner(snapshot.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        state.outputSequence = snapshot.seq
      })
      .catch(() => {
        state.modelOperationFailed = true
        // Best-effort: live bytes already chain behind this replacement state.
      })
      .finally(() => {
        if (this.headlessTerminals.get(ptyId) === state) {
          this.providerSnapshotPreferredPtys.delete(ptyId)
        }
      })
  }

  protected resizeHeadlessTerminal(
    ptyId: string,
    cols: number,
    rows: number,
    cellSize?: TerminalImageCellSize
  ): void {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnation = this.ptysById.get(ptyId)?.incarnationId
    const measured = readTerminalImageCellSize(cellSize) ?? undefined
    if (measured) {
      state.acceptedImageCellSize = { cellSize: measured, generation, incarnation }
    }
    const unpainted = state.unrepaintedReflowGrid
    // Why: a PTY resize off the reflowed grid makes the TUI repaint; an echo of it does not.
    if (unpainted && (unpainted.cols !== cols || unpainted.rows !== rows)) {
      state.unrepaintedReflowGrid = undefined
    }
    // Why: terminal reflow is a parser operation. It must sit in the same
    // per-PTY stream as output bytes or restore snapshots can bake in wraps
    // from the wrong terminal width.
    state.writeChain = state.writeChain
      .then(() => {
        if (
          this.headlessTerminals.get(ptyId) !== state ||
          this.getPtyLifecycleGeneration(ptyId) !== generation ||
          this.ptysById.get(ptyId)?.incarnationId !== incarnation
        ) {
          return
        }
        if (measured) {
          state.emulator.resize(cols, rows, measured)
        } else {
          state.emulator.resize(cols, rows)
        }
      })
      .catch(() => {
        state.modelOperationFailed = true
        // Best-effort mirror tracking; live PTY streaming must continue even
        // if xterm rejects a raced resize during teardown.
      })
  }

  /** Public: reflow an already-created model onto a grid the PROVIDER proved — a reattach learns
   *  the live session's real size only from its spawn reply, after live bytes may have lazily
   *  created the model at the 80x24 default. Not onExternalPtyResize: nothing measured a pane
   *  here, so the renderer-geometry baselines behind mobile take-back must stay untouched. */
  reflowHeadlessTerminalToPtyGrid(ptyId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return
    }
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    const applied = state.emulator.getAppliedSize()
    this.resizeHeadlessTerminal(ptyId, cols, rows)
    // Why: nothing resized the PTY, so the TUI does not repaint and its cells keep the old grid.
    if (applied.cols !== cols || applied.rows !== rows) {
      state.unrepaintedReflowGrid = { cols, rows }
    }
  }

  // Public: desktop-initiated clears (ipc/pty.ts) must also drop this mobile
  // mirror or a resubscribing mobile client resurrects the cleared scrollback.
  async clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    // Why: headless writes are queued to preserve xterm parser order. Clear
    // must join that same chain or an earlier PTY chunk can finish after the
    // clear request and repopulate mobile scrollback.
    const completion = state.writeChain.then(() => state.emulator.clearScrollback())
    state.writeChain = completion.catch(() => {
      state.modelOperationFailed = true
    })
    await completion
  }

  // Public: Reset Terminal must ground this model too; park/reveal and mobile restore from it.
  async resetHeadlessTerminalInputModes(ptyId: string): Promise<void> {
    // Why now, not on the chain: onPtyData scans live bytes into these on arrival.
    // Focus is outside their model, so the plain ground is exact.
    this.scanProviderModeTrackers(ptyId, PROCESS_BOUNDARY_GROUND)
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    // Why on the chain: the ground must land after every PTY chunk already queued.
    const completion = state.writeChain.then(async () => {
      await state.emulator.write(state.ownership.groundInputModes())
    })
    state.writeChain = completion.catch(() => {
      state.modelOperationFailed = true
    })
    await completion
  }
}
