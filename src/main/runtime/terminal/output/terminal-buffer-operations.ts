import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type {
  HeadlessSeedMetadata,
  ProviderTerminalBufferWait,
  RuntimeHeadlessTerminal
} from '../../runtime-terminal-state-records'
import type { OrcaRuntimeWithSerializeTerminalBufferFromAvailableState } from './terminal-buffer-selection'
import { OrcaRuntimeWithNotifyRemoteTerminalViewPresenceChanged } from '../layout/terminal-view-presence'
import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'
import {
  applyRestoredTerminalTailSeed,
  buildRestoredTerminalTailSeed,
  restoredTerminalTailSeedAllowed
} from '../../terminal-tail-restore-seed'

export abstract class OrcaRuntimeWithSerializeMainTerminalBuffer extends OrcaRuntimeWithNotifyRemoteTerminalViewPresenceChanged {
  protected abstract serializePreferredRestoredTerminalBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): ReturnType<
    OrcaRuntimeWithSerializeTerminalBufferFromAvailableState['serializePreferredRestoredTerminalBuffer']
  >
  protected abstract serializeHeadlessTerminalBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number; includeEmpty?: boolean }
  ): Promise<{
    data: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
    // Restore dangling escapes after all resets so the next live chunk completes them (#7329).
    pendingEscapeTailAnsi?: string
  } | null>
  abstract serializeRendererTerminalBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
  } | null>
  protected abstract serializeProviderTerminalBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number },
    wait?: { timeoutMs?: number; retireOnTimeout?: boolean }
  ): Promise<PtyProviderBufferSnapshot | null>
  protected abstract awaitProviderTerminalBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number },
    wait?: { timeoutMs?: number; retireOnTimeout?: boolean }
  ): Promise<ProviderTerminalBufferWait>
  abstract resolveLeafForHandle(handle: string): { ptyId: string | null } | null
  abstract clearHeadlessTerminalBuffer(ptyId: string): Promise<void>
  abstract resetHeadlessTerminalInputModes(ptyId: string): Promise<void>
  protected abstract createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number }
  ): RuntimeHeadlessTerminal
  protected abstract applySeededAgentStatus(ptyId: string, title: string): void

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
    pendingEscapeTailAnsi?: string
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
    const restoredSnapshot = await this.serializePreferredRestoredTerminalBuffer(ptyId, opts)
    if (restoredSnapshot) {
      return restoredSnapshot
    }
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, {
      ...opts,
      includeEmpty: true
    })
    if (headlessSnapshot) {
      return headlessSnapshot
    }
    // Before headless state exists, use the mounted xterm for desktop recovery instead of falsely reporting no snapshot.
    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    return rendererSnapshot ?? this.serializeProviderTerminalBuffer(ptyId, opts)
  }

  async clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (!leaf?.ptyId) {
      throw new Error('terminal_not_found')
    }
    // Clear is a UI action, not shell input; clear renderer/provider and headless history before mobile snapshots.
    await this.ptyController?.clearBuffer?.(leaf.ptyId)
    await this.clearHeadlessTerminalBuffer(leaf.ptyId)
    return { handle, cleared: true }
  }

  async resetTerminalInputModes(handle: string): Promise<{ handle: string; reset: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (!leaf?.ptyId) {
      throw new Error('terminal_not_found')
    }
    await this.ptyController?.resetInputModes?.(leaf.ptyId)
    await this.resetHeadlessTerminalInputModes(leaf.ptyId)
    return { handle, reset: true }
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.ptyController?.getSize?.(ptyId) ?? null
  }

  // Normal-buffer resize replays scrollback; alt-screen TUIs repaint themselves. Restored partial models defer screen-mode authority to the provider.
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

  // Adopted daemon sessions need retained-history hydration after relaunch or the empty headless model hides history from mobile.
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
    const seededSequence = this.getPtyOutputSequence(ptyId)
    this.headlessTerminals.set(ptyId, state)
    this.recordOsc7MetadataForPty(ptyId, data)
    this.recordRecentPtyOutput(ptyId, data)
    state.writeChain = state.writeChain
      .then(async () => {
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        // Why: seed writes never set forwardQueryReplies — the main-side
        // replay guard. A snapshot containing old queries must answer no one.
        await state.emulator.write(data)
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        // Why only now: a reader comparing sequences must not take the unseeded grid as current.
        state.outputSequence = seededSequence
        // Replay kitty flags after seed data for deterministic parsing; both must remain silent to historical queries.
        if (typeof metadata.kittyKeyboardFlags === 'number') {
          await state.emulator.applyKittyKeyboardFlags(metadata.kittyKeyboardFlags)
          if (this.headlessTerminals.get(ptyId) !== state) {
            return
          }
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

  // Restore RPC bytes bypass onPtyData; seed read/list state without waiters, orchestration events or fresh-output clocks.
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
      // Why: an adopting runtime may already have published this tab under its default title.
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }
}
