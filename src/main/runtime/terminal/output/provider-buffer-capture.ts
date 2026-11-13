import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from '../records/runtime-terminal-state-records'
import { OrcaRuntimeWithSerializeTerminalBufferFromAvailableState } from './terminal-buffer-selection'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import type { RuntimeTerminalRead } from '../../../../shared/runtime-terminal-contracts'
import type { RuntimeProviderSnapshotReadOptions } from './provider-snapshot-read-options'
import {
  buildVisibleSnapshotReadFallback,
  shouldFallbackToVisibleTerminalSnapshot,
  terminalReadLimit
} from './tail/terminal-tail-read'
import type { RuntimeTerminalProjection } from './terminal-projection'
import { DEFAULT_TERMINAL_READ_LIMIT } from './tail/terminal-tail-limits'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import {
  projectTerminalTailLines,
  projectTerminalVisibleLines
} from '../view/orca-runtime-terminal-projection'
import { VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './provider-snapshot-budget'
import { isNativeWindowsConptyPty } from './terminal-model-query-authority'
import type { ProviderVisibleRead } from '../lifecycle/terminal-view-resources'

/** The read with a nonblank visible projection in place of its tail; otherwise the read itself. */
function withVisibleProjection(
  read: RuntimeTerminalRead,
  projection: RuntimeTerminalProjection | null,
  limit: number | undefined
): RuntimeTerminalRead {
  return projection && projection.lines.length > 0
    ? buildVisibleSnapshotReadFallback(
        read,
        projection.lines,
        limit,
        projection.draft,
        projection.tailRows
      )
    : read
}

export abstract class OrcaRuntimeWithCaptureProviderTerminalBuffer extends OrcaRuntimeWithSerializeTerminalBufferFromAvailableState {
  protected abstract readVisibleTerminalState(
    ptyId: string,
    opts?: { entry?: ProviderVisibleRead; timeoutMs?: number }
  ): Promise<RuntimeVisibleTerminalState | null>
  protected abstract readSharedVisibleProviderFrame(
    ptyId: string,
    timeoutMs?: number
  ): Promise<RuntimeTerminalProjection | null>
  protected abstract readHostCurrentFrame(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null>
  protected abstract readRendererVisibleSnapshotLines(
    ptyId: string,
    entry: ProviderVisibleRead,
    timeoutMs?: number
  ): Promise<RuntimeTerminalProjection>
  protected abstract readWholeScreenModel(
    ptyId: string | null | undefined
  ): RuntimeHeadlessTerminal | null
  protected abstract parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<RuntimeTerminalProjection>

  /**
   * A visible read passes `false` and publishes the snapshot's screen mode only when its frame is
   * applicable. A lower acquisition passes its owner's check, asked with the reconciled sequence
   * at completion: a superseded capture still answers its caller but leaves the shared mode alone.
   */
  protected async captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number,
    publishMode: boolean | ((reconciledSeq: number) => boolean) = true
  ): Promise<PtyProviderBufferSnapshot | null> {
    const liveModeTracker = new TerminalKittyKeyboardModeTracker()
    let liveModeTrackers = this.providerModeSnapshotScansByPtyId.get(ptyId)
    if (!liveModeTrackers) {
      liveModeTrackers = new Set()
      this.providerModeSnapshotScansByPtyId.set(ptyId, liveModeTrackers)
    }
    liveModeTrackers.add(liveModeTracker)
    try {
      // Why: daemon PTYs survive an app relaunch before any renderer mounts.
      // Mobile still needs their retained history without navigating desktop.
      const snapshot = await this.ptyController?.serializeProviderBuffer?.(ptyId, opts)
      if (!snapshot || this.ptyLifecycleGenerationById.get(ptyId) !== generation) {
        return null
      }
      const snapshotModeTracker = new TerminalKittyKeyboardModeTracker()
      if (typeof snapshot.alternateScreen === 'boolean') {
        snapshotModeTracker.scan(snapshot.alternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      } else {
        // Why: older providers omit mode metadata, but their ANSI snapshot
        // still carries the DECSET/DECRST needed to classify the active screen.
        snapshotModeTracker.scanReplay(snapshot.data)
      }
      const observedSnapshotMode = snapshotModeTracker.hasObservedAlternateScreenSwitch
      let effectiveAlternateScreen: boolean | undefined
      if (observedSnapshotMode || liveModeTracker.hasObservedAlternateScreenSwitch) {
        const modeTracker = new TerminalKittyKeyboardModeTracker()
        if (observedSnapshotMode) {
          modeTracker.scan(snapshotModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
        }
        // Why: stream bytes received after the request began can be newer
        // than snapshot metadata, so an observed live transition wins.
        if (liveModeTracker.hasObservedAlternateScreenSwitch) {
          modeTracker.scan(liveModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
        }
        // Same synchronous section as the owner's check: nothing can supersede it in between.
        const reconciledSeq = (this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0) + snapshot.seq
        if (typeof publishMode === 'function' ? publishMode(reconciledSeq) : publishMode) {
          this.providerModeTrackersByPtyId.set(ptyId, modeTracker)
        }
        effectiveAlternateScreen = modeTracker.isAlternateScreen
      }
      const providerOffset = this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0
      const reconciledSnapshot = this.preferTrackedLastTitle(ptyId, {
        ...snapshot,
        seq: providerOffset + snapshot.seq,
        ...(effectiveAlternateScreen !== undefined
          ? { alternateScreen: effectiveAlternateScreen }
          : {})
      })
      if (liveModeTracker.hasObservedAlternateScreenSwitch) {
        this.providerSnapshotsWithLiveModeTransition.add(reconciledSnapshot)
      }
      return reconciledSnapshot
    } catch {
      return null
    } finally {
      liveModeTrackers.delete(liveModeTracker)
      if (
        liveModeTrackers.size === 0 &&
        this.providerModeSnapshotScansByPtyId.get(ptyId) === liveModeTrackers
      ) {
        this.providerModeSnapshotScansByPtyId.delete(ptyId)
      }
    }
  }

  protected async withVisibleSnapshotFallback(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { cursor?: number; limit?: number } = {},
    providerSnapshot: RuntimeProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    if (typeof opts.cursor === 'number') {
      return read
    }
    if (this.hasHostHistoryAuthority(ptyId)) {
      return this.withHostHistoryFallback(ptyId, read, opts, providerSnapshot)
    }
    // A supplied deadline is one budget spent across every stage this read reaches.
    const remaining = this.spendProviderSnapshotDeadline(providerSnapshot)
    const blankFallback = shouldFallbackToVisibleTerminalSnapshot(read, opts)
    const recoveredWorkerFallback =
      read.tail.length === 0 && this.legacyWorkerRecovery.hasRecoveredPty(ptyId)
    // Why: a live daemon session no pane ever attached has ingested zero bytes,
    // so only the provider holds its screen. Unprovable state stays empty.
    const neverAttachedProviderFallback =
      read.tail.length === 0 &&
      !recoveredWorkerFallback &&
      this.isKnownUnattachedLocalDaemonPty(ptyId)
    if (recoveredWorkerFallback || neverAttachedProviderFallback) {
      const providerProjection = await this.readProviderTerminalTailLines(
        ptyId,
        opts.limit,
        remaining()
      )
      if (providerProjection && providerProjection.lines.length > 0) {
        return withVisibleProjection(read, providerProjection, opts.limit)
      }
    }
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
    const providerModeUnknown =
      this.providerSnapshotPreferredPtys.has(ptyId) && !this.providerModeTrackersByPtyId.has(ptyId)
    const conpty = isNativeWindowsConptyPty(ptyId)
    if (
      !blankFallback &&
      !recoveredWorkerFallback &&
      !providerModeUnknown &&
      !knownAlternateScreen &&
      !conpty &&
      !this.headlessTerminals.has(ptyId)
    ) {
      return read
    }
    // The renderer continuation is held on the same read from before its primary to its return.
    return this.withProviderVisibleRead(ptyId, false, async (entry) => {
      const visibleState = await this.readVisibleTerminalState(ptyId, {
        entry,
        timeoutMs: remaining().timeoutMs
      })
      if (
        !blankFallback &&
        !recoveredWorkerFallback &&
        !knownAlternateScreen &&
        !visibleState?.isAlternateScreen
      ) {
        return conpty
          ? await this.withConptyRenderedTail(ptyId, read, opts.limit, remaining())
          : read
      }
      let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
      if (projection.lines.length === 0) {
        projection = await this.readRendererVisibleSnapshotLines(
          ptyId,
          entry,
          remaining().timeoutMs
        )
      }
      return withVisibleProjection(read, projection, opts.limit)
    })
  }

  /**
   * Optional substitutions for a host-owned binding read only the daemon's answer; when it is
   * unavailable the caller gets the original bounded stream read, never another model's rows.
   */
  private async withHostHistoryFallback(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { limit?: number },
    providerSnapshot: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalRead> {
    const historical =
      read.tail.length === 0 &&
      (this.legacyWorkerRecovery.hasRecoveredPty(ptyId) ||
        this.isKnownUnattachedLocalDaemonPty(ptyId))
    const blank = shouldFallbackToVisibleTerminalSnapshot(read, opts)
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
    const conpty = isNativeWindowsConptyPty(ptyId)
    let projection: RuntimeTerminalProjection | null = null
    if (historical) {
      projection = await this.readProviderTerminalTailLines(ptyId, opts.limit, providerSnapshot)
    } else if (blank || knownAlternateScreen || conpty || this.headlessTerminals.has(ptyId)) {
      const frame = await this.readHostCurrentFrame(ptyId)
      if (blank || knownAlternateScreen || frame?.isAlternateScreen) {
        projection = frame
      } else if (conpty) {
        projection = await this.readRenderedTerminalTailLines(ptyId, opts.limit, providerSnapshot)
      }
    }
    return withVisibleProjection(read, projection, opts.limit)
  }

  // ConPTY absolute cursor paints overwrite text that raw tails retain, including ghost PSReadLine predictions; read rendered cells.
  private async withConptyRenderedTail(
    ptyId: string,
    read: RuntimeTerminalRead,
    limit: number | undefined,
    providerSnapshot: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalRead> {
    const projection = await this.readRenderedTerminalTailLines(ptyId, limit, providerSnapshot)
    return withVisibleProjection(read, projection, limit)
  }

  private async readRenderedTerminalTailLines(
    ptyId: string,
    limit: number | undefined,
    providerSnapshot: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalProjection | null> {
    // Over-fetch a screen so blank rows below the prompt cannot consume the requested nonblank line count.
    const rowLimit =
      terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT) +
      (this.getTerminalSize(ptyId)?.rows ?? 0)
    const state = this.hasHostHistoryAuthority(ptyId) ? null : this.readWholeScreenModel(ptyId)
    if (!state) {
      return this.readProviderTerminalTailLines(ptyId, rowLimit, {
        timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
        ...providerSnapshot
      })
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    await state.writeChain
    if (
      this.headlessTerminals.get(ptyId) !== state ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return { lines: [] }
    }
    return providerSnapshot.visibleScreenOnly
      ? projectTerminalVisibleLines(state.emulator)
      : projectTerminalTailLines(state.emulator, rowLimit)
  }

  protected async readProviderTerminalTailLines(
    ptyId: string,
    limit: number | undefined,
    snapshotOptions: RuntimeProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalProjection | null> {
    // A visible-only read is the current screen: it shares the visible read's capture and parse.
    if (snapshotOptions.visibleScreenOnly) {
      return this.readSharedVisibleProviderFrame(ptyId, snapshotOptions.timeoutMs)
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
    const snapshot = await this.serializeProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: lineLimit },
      snapshotOptions
    )
    // Null stays unavailable until the caller picks structural failure or its original stream.
    if (!snapshot) {
      return null
    }
    const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
    if (data.length === 0) {
      return { lines: [] }
    }
    const emulator = new HeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: lineLimit
    })
    try {
      await emulator.write(data)
      const projection = projectTerminalTailLines(emulator, lineLimit)
      return this.ptyLifecycleGenerationById.get(ptyId) === generation &&
        this.getPtyOutputSequence(ptyId) <= snapshot.seq
        ? projection
        : null
    } finally {
      emulator.dispose()
    }
  }
}
