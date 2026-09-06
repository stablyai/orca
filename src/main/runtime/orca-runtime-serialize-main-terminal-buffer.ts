// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithAttachRemoteTerminalSourceRangeConsumer } from './orca-runtime-attach-remote-terminal-source-range-consumer'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { HeadlessSeedMetadata } from './runtime-terminal-state-records'
import {
  applyRestoredTerminalTailSeed,
  buildRestoredTerminalTailSeed,
  restoredTerminalTailSeedAllowed
} from './terminal-tail-restore-seed'

export class OrcaRuntimeWithSerializeMainTerminalBuffer extends OrcaRuntimeWithAttachRemoteTerminalSourceRangeConsumer {
  serializeMainTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    return this.serializeHeadlessTerminalBuffer(ptyId, { ...opts, includeEmpty: true })
  }

  async serializeHiddenOutputRecoveryBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, {
      ...opts,
      includeEmpty: true
    })
    if (headlessSnapshot) {
      return headlessSnapshot
    }
    // Why: hidden-output recovery is initiated by the desktop renderer. If the
    // runtime has not built headless state yet, the mounted xterm is still the
    // best available state and avoids a false "snapshot unavailable" result.
    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    return rendererSnapshot ?? this.serializeProviderTerminalBuffer(ptyId, opts)
  }

  async clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (!leaf?.ptyId) {
      throw new Error('terminal_not_found')
    }
    // Why: clear is a terminal UI action (Cmd+K on desktop), not shell input.
    // Route through the controller so renderer-owned xterm buffers, daemon
    // sessions, and SSH relay sessions all drop scrollback before the next
    // mobile snapshot.
    await this.ptyController?.clearBuffer?.(leaf.ptyId)
    await this.clearHeadlessTerminalBuffer(leaf.ptyId)
    return { handle, cleared: true }
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.ptyController?.getSize?.(ptyId) ?? null
  }

  // Why: a width reflow on a normal-buffer PTY must re-stream the full
  // scrollback to mobile so it rewraps at the new cols, but alternate-screen
  // TUIs (vim, Claude Code) own their repaint and have no scrollback — for
  // those the mobile client just resizes xterm geometry and consumes the
  // TUI's own redraw, so the resize re-stream must be skipped. Provider state
  // covers restored PTYs whose main-side emulator is only a partial suffix.
  isTerminalAlternateScreen(ptyId: string): boolean {
    if (this.providerSnapshotPreferredPtys.has(ptyId)) {
      return this.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen ?? false
    }
    return (
      this.headlessTerminals.get(ptyId)?.emulator.isAlternateScreen ??
      this.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen ??
      false
    )
  }

  // Why: daemon-backed PTYs that the runtime adopted after an Orca relaunch
  // start with a fresh headless emulator that has zero scrollback, even though
  // the daemon's on-disk checkpoint and the desktop xterm both contain the
  // full prior history. Without this hydration, mobile subscribers see only
  // the bare current prompt because serializeHeadlessTerminalBuffer always
  // wins over the renderer-path fallback. Seeding the emulator with the
  // adapter's snapshot/cold-restore data makes mobile and desktop agree on
  // what scrollback is available.
  seedHeadlessTerminal(
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata: HeadlessSeedMetadata = {}
  ): void {
    if (!data) {
      return
    }
    const existing = this.headlessTerminals.get(ptyId)
    if (existing) {
      // Why: emulator already has live data — re-seeding would duplicate
      // every byte. The seed is only valid when the emulator is fresh.
      if (metadata.preferProviderIfExisting) {
        this.providerSnapshotPreferredPtys.add(ptyId)
      }
      return
    }
    const dims = size ?? this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.getPtyOutputSequence(ptyId)
    this.headlessTerminals.set(ptyId, state)
    this.recordOsc7MetadataForPty(ptyId, data)
    this.recordRecentPtyOutputForPathProvenance(ptyId, data)
    state.writeChain = state.writeChain
      .then(async () => {
        // Why: seed writes never set forwardQueryReplies — the main-side
        // replay guard. A snapshot containing old queries must answer no one.
        await state.emulator.write(data)
        // Why AFTER the seed write: the snapshot payload cannot carry kitty
        // pushes (rehydrateSequences deliberately omits them), but ordering
        // behind it keeps the parse deterministic. Unflagged like the seed —
        // re-applying flags must answer no one.
        if (typeof metadata.kittyKeyboardFlags === 'number') {
          await state.emulator.applyKittyKeyboardFlags(metadata.kittyKeyboardFlags)
        }
        if (metadata.cwd !== undefined) {
          state.emulator.setCwd(metadata.cwd)
        }
        if (metadata.oscLinks !== undefined) {
          state.emulator.setRestoredOscLinks(metadata.oscLinks)
        }
        // Why derived from the emulator: the seed bytes bypass ownership.scan,
        // so the scanner must inherit the restored alternate-screen state or a
        // pane seeded mid-TUI never arms its recovery trigger.
        state.ownership.seedOwner(metadata.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        this.providerSnapshotPreferredPtys.delete(ptyId)
      })
      .catch(() => {
        // Seeding is best-effort; live data will continue to populate the
        // emulator even if the snapshot replay fails.
      })
  }

  // Why: reattach/cold-restore/replay payloads arrive as spawn RPC results and
  // never pass through onPtyData, so after a relaunch the records backing
  // `terminal list`/`terminal read` stayed blank while the session was alive.
  // Seed semantics (applySeededAgentStatus precedent): write state only — no
  // waiters, no orchestration events, and no lastOutputAt, because restored
  // bytes are historical output, not fresh activity.
  seedTerminalRestoreTail(ptyId: string, restore: { text?: string; lastTitle?: string }): void {
    const seed = restore.text ? buildRestoredTerminalTailSeed(restore.text) : null
    if (seed) {
      const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
      // Why: live bytes outrank the seed — only never-written records take it,
      // so a same-run remount reattach cannot re-apply history it already has.
      if (pty && restoredTerminalTailSeedAllowed(pty)) {
        applyRestoredTerminalTailSeed(pty, seed)
        this.primeWaitBlockedBaselineFromSeededTail(ptyId)
      }
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (restoredTerminalTailSeedAllowed(leaf)) {
          applyRestoredTerminalTailSeed(leaf, seed)
        }
      }
    }
    if (restore.lastTitle) {
      // Why: mirror renderer hydration — a title main already tracked live outranks the payload's persisted one.
      this.applySeededAgentStatus(ptyId, this.getTrackedRawTitleForPty(ptyId) ?? restore.lastTitle)
    }
  }
}
