import { OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer } from './headless-terminal-hydration'
import type { RuntimeHeadlessTerminal } from '../../runtime-terminal-state-records'
import { HeadlessEmulator } from '../../../daemon/headless-emulator'
import { shouldForwardHeadlessTerminalQueryReply } from '../../headless-terminal-query-reply-policy'
import { isNativeWindowsConptyPty } from '../../terminal-model-query-authority'
import { getTerminalViewAttributes } from '../../terminal-view-attribute-store'
import { PtyShellOwnershipMirror } from '../../pty-shell-ownership-mirror'
import { PROCESS_BOUNDARY_GROUND } from '../../../../shared/terminal-mode-reset-profiles'
import { release } from 'node:os'
import { resolvePtyOwnerBackend, type PtyOwnerBackend } from '../../../../shared/pty-owner-backend'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { windowsPtyForOwnerBackend } from '../../../../shared/xterm-conpty-options'

export abstract class OrcaRuntimeWithCreatePtyHeadlessTerminalState extends OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer {
  /** SSH and paired-runtime panes run on their host's PTY; every PTY this Windows process owns is ConPTY. */
  private ownerBackendForHeadlessPty(ptyId: string): PtyOwnerBackend {
    // Why the id too: main's copy starts on the first byte, before a restored relay PTY has a record.
    if (
      this.ptysById.get(ptyId)?.connectionId ||
      parseAppSshPtyId(ptyId) !== null ||
      isRemoteRuntimePtyId(ptyId)
    ) {
      return 'posix-pty'
    }
    return resolvePtyOwnerBackend({ platform: process.platform, shellPath: undefined })
  }

  /** Create runtime emulators with query forwarding and ConPTY DA1 override for seed, hydration and live bytes; daemon emulators use another factory. */
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
      windowsPty: windowsPtyForOwnerBackend(this.ownerBackendForHeadlessPty(ptyId), release()),
      // Use provider input for query replies to retain shell-ready/SSH routing without interactive echo metering.
      onQueryReply: (reply) => {
        // Queued links can outlive disposal; only the current state may reply to a reused PTY id.
        if (state !== null && this.headlessTerminals.get(ptyId) === state) {
          if (
            !shouldForwardHeadlessTerminalQueryReply(this.ptysById.get(ptyId)?.launchAgent, reply)
          ) {
            return
          }
          // Daemon writes queue until the shell-ready marker or 15s timeout, preserving spawn-time replies.
          this.ptyController?.write(ptyId, reply, 'query-reply')
        }
      }
    })
    if (isNativeWindowsConptyPty(ptyId)) {
      emulator.installConptyPrimaryDeviceAttributesOverride()
    }
    // Read latest viewer attributes at parse time; remain silent before the first push.
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

  /** Idempotently retrofit ConPTY DA1 when spawn metadata arrives after live bytes created the emulator (terminal-query-authority.md). */
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
        // Best-effort: live bytes already chain behind this replacement state.
      })
      .finally(() => {
        if (this.headlessTerminals.get(ptyId) === state) {
          this.providerSnapshotPreferredPtys.delete(ptyId)
        }
      })
  }

  protected resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    const unpainted = state.unrepaintedReflowGrid
    // Why: a PTY resize off the reflowed grid makes the TUI repaint; an echo of it does not.
    if (unpainted && (unpainted.cols !== cols || unpainted.rows !== rows)) {
      state.unrepaintedReflowGrid = undefined
    }
    // Reflow joins the byte stream so snapshots cannot capture wraps from an out-of-order width change.
    state.writeChain = state.writeChain
      .then(() => {
        state.emulator.resize(cols, rows)
      })
      .catch(() => {
        // Best-effort mirror tracking; live PTY streaming must continue even
        // if xterm rejects a raced resize during teardown.
      })
  }

  /** Reflow to provider-proven size after early live bytes used default geometry; preserve renderer restore baselines because no pane was measured. */
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
    // Queue clears after earlier output so it cannot repopulate cleared mobile scrollback.
    state.writeChain = state.writeChain.then(() => state.emulator.clearScrollback())
    await state.writeChain
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
    state.writeChain = completion.catch(() => {})
    await completion
  }
}
