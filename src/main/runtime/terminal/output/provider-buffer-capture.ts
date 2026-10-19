import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithSerializeTerminalBufferFromAvailableState } from './terminal-buffer-selection'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { RuntimeTerminalRead } from '../../../../shared/runtime-types'
import type { RuntimeProviderSnapshotReadOptions } from '../../runtime-terminal-contracts'
import {
  buildVisibleSnapshotReadFallback,
  shouldFallbackToVisibleTerminalSnapshot,
  terminalReadLimit
} from '../../terminal-tail-read'
import type { RuntimeTerminalProjection } from '../../orca-runtime-core'
import { DEFAULT_TERMINAL_READ_LIMIT } from '../../terminal-tail-limits'
import { HeadlessEmulator } from '../../../daemon/headless-emulator'
import {
  projectTerminalTailLines,
  projectTerminalVisibleLines
} from '../../orca-runtime-terminal-projection'
import { VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../../orca-runtime-postlude'
import { isNativeWindowsConptyPty } from '../../terminal-model-query-authority'

export abstract class OrcaRuntimeWithCaptureProviderTerminalBuffer extends OrcaRuntimeWithSerializeTerminalBufferFromAvailableState {
  protected abstract readVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null>
  protected abstract readRendererVisibleSnapshotLines(
    ptyId: string
  ): Promise<RuntimeTerminalProjection>
  protected abstract readWholeScreenModel(
    ptyId: string | null | undefined
  ): RuntimeHeadlessTerminal | null
  protected abstract parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<RuntimeTerminalProjection>

  protected async captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number
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
        this.providerModeTrackersByPtyId.set(ptyId, modeTracker)
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
        providerSnapshot
      )
      if (providerProjection.lines.length > 0) {
        return buildVisibleSnapshotReadFallback(
          read,
          providerProjection.lines,
          opts.limit,
          providerProjection.draft,
          providerProjection.tailRows
        )
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
    const visibleState = await this.readVisibleTerminalState(ptyId)
    if (
      !blankFallback &&
      !recoveredWorkerFallback &&
      !knownAlternateScreen &&
      !visibleState?.isAlternateScreen
    ) {
      return conpty
        ? await this.withConptyRenderedTail(ptyId, read, opts.limit, providerSnapshot)
        : read
    }
    let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
    if (projection.lines.length === 0) {
      projection = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    if (projection.lines.length === 0) {
      return read
    }
    return buildVisibleSnapshotReadFallback(
      read,
      projection.lines,
      opts.limit,
      projection.draft,
      projection.tailRows
    )
  }

  // Why: ConPTY re-encodes all output as screen paints placed by absolute cursor moves the stream
  // tail cannot follow, so overwritten text survives in it — e.g. PSReadLine's ghost history
  // prediction (another shell's command) reads as typed before this terminal's own input.
  private async withConptyRenderedTail(
    ptyId: string,
    read: RuntimeTerminalRead,
    limit: number | undefined,
    providerSnapshot: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalRead> {
    const projection = await this.readRenderedTerminalTailLines(ptyId, limit, providerSnapshot)
    return projection.lines.length > 0
      ? buildVisibleSnapshotReadFallback(
          read,
          projection.lines,
          limit,
          projection.draft,
          projection.tailRows
        )
      : read
  }

  private async readRenderedTerminalTailLines(
    ptyId: string,
    limit: number | undefined,
    providerSnapshot: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalProjection> {
    // Why over-fetch by a screen: the projection drops blank grid rows after taking its rows, so
    // the empty rows below the prompt would otherwise eat into the requested line count.
    const rowLimit =
      terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT) +
      (this.getTerminalSize(ptyId)?.rows ?? 0)
    const state = this.readWholeScreenModel(ptyId)
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
  ): Promise<RuntimeTerminalProjection> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
    const snapshot = await this.serializeProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: snapshotOptions.visibleScreenOnly ? 0 : lineLimit },
      snapshotOptions
    )
    if (!snapshot) {
      return { lines: [] }
    }
    // Why: a cached acquisition can carry scrollback this caller did not ask for,
    // so visible-only reads parse the grid itself rather than trusting the request.
    if (snapshotOptions.visibleScreenOnly) {
      const projection = await this.parseVisibleSnapshot(snapshot)
      // Live bytes ordered after the provider frame make that frame stale.
      return this.ptyLifecycleGenerationById.get(ptyId) === generation &&
        this.getPtyOutputSequence(ptyId) <= snapshot.seq
        ? projection
        : { lines: [] }
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
        : { lines: [] }
    } finally {
      emulator.dispose()
    }
  }
}
