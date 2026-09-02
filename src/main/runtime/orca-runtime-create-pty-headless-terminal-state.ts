// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer } from './orca-runtime-maybe-hydrate-headless-from-renderer'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'
import { isNativeWindowsConptyPty } from './terminal-model-query-authority'
import { getTerminalViewAttributes } from './terminal-view-attribute-store'
import { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'

export class OrcaRuntimeWithCreatePtyHeadlessTerminalState extends OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer {
  /** Shared factory for the per-PTY runtime emulators (seed, hydration, and
   *  lazy live-byte creation): wires the Phase-5 query-reply sink and the
   *  ConPTY DA1 override. The daemon emulator never goes through here. */
  protected createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number }
  ): RuntimeHeadlessTerminal {
    let state: RuntimeHeadlessTerminal | null = null
    const pathFlavor = this.pathFlavorForPty(this.ptysById.get(ptyId))
    const emulator = new HeadlessEmulator({
      cols: dims.cols,
      rows: dims.rows,
      pathFlavor,
      remotePosixFileUriAuthority:
        !!this.ptysById.get(ptyId)?.connectionId && pathFlavor !== 'win32',
      wslDistro: this.ptysById.get(ptyId)?.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(ptyId) ?? this.ptysById.get(ptyId)?.wslDistro ?? undefined),
      // Why: replies take the provider input path (same entry as pty:write —
      // daemon shell-ready gating and the SSH relay write apply unchanged),
      // NOT writePtyInput, so renderer interactive-output metering never
      // counts responder traffic as user-input echo.
      onQueryReply: (reply) => {
        // Why the identity check: queued writeChain links can parse after
        // disposeHeadlessTerminal, and daemon respawns reuse session ids — a
        // stale link's reply must never reach a successor PTY under this id.
        if (state !== null && this.headlessTerminals.get(ptyId) === state) {
          if (
            !shouldForwardHeadlessTerminalQueryReply(this.ptysById.get(ptyId)?.launchAgent, reply)
          ) {
            return
          }
          // Why this write is safe pre-shell-ready: daemon Session.write
          // QUEUES (never drops) input while the POSIX shell-ready gate is
          // pending and flushes at the ready marker or the 15s
          // SHELL_READY_TIMEOUT_MS bound (session.ts) — a spawn-time query
          // reply is delayed at most that bound, not lost.
          this.ptyController?.write(ptyId, reply)
        }
      }
    })
    if (isNativeWindowsConptyPty(ptyId)) {
      emulator.installConptyPrimaryDeviceAttributesOverride()
    }
    // Why the lazy getter: replies must use the freshest renderer push at
    // parse time, and stay silent (never default) before the first push.
    emulator.installViewAttributeResponder(() => getTerminalViewAttributes())
    const viewAttributes = getTerminalViewAttributes()
    if (viewAttributes) {
      emulator.applyPushedViewAttributes(viewAttributes)
    }
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
    this.disposeHeadlessTerminal(ptyId)
    this.providerSnapshotPreferredPtys.add(ptyId)
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    this.headlessTerminals.set(ptyId, state)
    state.writeChain = state.writeChain
      .then(async () => {
        const snapshot = await this.serializeProviderTerminalBuffer(ptyId)
        if (!snapshot) {
          return
        }
        const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
        // Why: a newer live OSC 7 can arrive while the snapshot is in flight;
        // only seed metadata while no post-correction CWD has won the race.
        if (!this.terminalCwdByPtyId.has(ptyId)) {
          this.recordOsc7MetadataForPty(ptyId, data)
        }
        await state.emulator.write(data)
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
        // Best-effort: live bytes already chain behind this replacement state.
      })
      .finally(() => {
        this.providerSnapshotPreferredPtys.delete(ptyId)
      })
  }

  protected resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    // Why: terminal reflow is a parser operation. It must sit in the same
    // per-PTY stream as output bytes or restore snapshots can bake in wraps
    // from the wrong terminal width.
    state.writeChain = state.writeChain
      .then(() => {
        state.emulator.resize(cols, rows)
      })
      .catch(() => {
        // Best-effort mirror tracking; live PTY streaming must continue even
        // if xterm rejects a raced resize during teardown.
      })
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
    state.writeChain = state.writeChain.then(() => state.emulator.clearScrollback())
    await state.writeChain
  }
}
