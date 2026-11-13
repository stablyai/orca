import { OrcaRuntimeWithCaptureProviderTerminalBuffer } from './provider-buffer-capture'
import type { RuntimeVisibleTerminalState } from '../records/runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type { RuntimeTerminalProjection } from './terminal-projection'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { withTimeout, withTimeoutResult } from '../../../../shared/promise-timeout-fallback'
import {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from './provider-snapshot-budget'
import {
  providerFrameFitsGrid,
  type ProviderVisibleCapture,
  type ProviderVisibleRead
} from '../lifecycle/terminal-view-resources'

/**
 * One owner per visible read, from source selection through every provider capture, parse and
 * publication. Shared stages carry no caller deadline; each caller bounds only its own wait.
 */
export abstract class OrcaRuntimeWithProviderVisibleRead extends OrcaRuntimeWithCaptureProviderTerminalBuffer {
  protected abstract readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null>

  /** The ordinary primary read; `timeoutMs` is a supplied caller deadline, never a retry signal. */
  protected readVisibleTerminalState(
    ptyId: string,
    opts: { entry?: ProviderVisibleRead; timeoutMs?: number } = {}
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      return this.readHeadlessVisibleTerminalState(ptyId)
    }
    const cached = this.readCurrentProviderVisibleState(ptyId)
    if (cached) {
      return Promise.resolve(cached)
    }
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    if (trackedMode && !trackedMode.isAlternateScreen) {
      const generation = this.getPtyLifecycleGeneration(ptyId)
      const sequence = this.getPtyOutputSequence(ptyId)
      return this.readHeadlessVisibleTerminalState(ptyId).then((headlessState) =>
        headlessState
          ? { ...headlessState, isAlternateScreen: false }
          : { lines: [], isAlternateScreen: false, sequence, generation }
      )
    }
    return this.withProviderVisibleRead(
      ptyId,
      false,
      (entry) => this.awaitPrimaryVisibleFrame(ptyId, entry, opts.timeoutMs),
      opts.entry
    )
  }

  /**
   * Public reads of a host-owned binding: the daemon's live scrollback-0 frame at the current
   * sequence. Private screen, input and status services keep reading main's projection.
   */
  protected readHostCurrentFrame(ptyId: string): Promise<RuntimeVisibleTerminalState | null> {
    return this.withProviderVisibleRead(
      ptyId,
      true,
      async (entry) =>
        this.readCurrentProviderVisibleState(ptyId, true) ??
        this.awaitPrimaryVisibleFrame(ptyId, entry)
    )
  }

  /** The restored-dialog probe: the provider's frame only, never a headless answer. */
  protected captureProviderVisibleState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    return this.withProviderVisibleRead(ptyId, false, (entry) =>
      this.awaitPrimaryVisibleFrame(ptyId, entry)
    )
  }

  /**
   * The public current screen: the primary read, then on null the one shared fallback capture.
   * With no supplied deadline it keeps today's sequential primary then authoritative allowance;
   * a supplied deadline is one budget spent across both.
   */
  protected readVisibleScreenFrame(
    ptyId: string,
    timeoutMs?: number
  ): Promise<RuntimeTerminalProjection | null> {
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
    const remaining = (fallbackMs: number): number =>
      deadline === null ? fallbackMs : Math.max(0, deadline - Date.now())
    return this.withProviderVisibleRead(ptyId, false, async (entry) => {
      const primary = await this.readVisibleTerminalState(ptyId, {
        entry,
        ...(deadline === null ? {} : { timeoutMs: remaining(0) })
      })
      if (primary) {
        return primary
      }
      return this.awaitVisibleFallback(
        ptyId,
        entry,
        remaining(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
      )
    })
  }

  /** A visible-only provider frame for a tail read: ungated, joining any capture this read already holds. */
  protected readSharedVisibleProviderFrame(
    ptyId: string,
    timeoutMs = AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS
  ): Promise<RuntimeTerminalProjection | null> {
    return this.withProviderVisibleRead(ptyId, false, (entry) =>
      this.awaitVisibleFallback(ptyId, entry, timeoutMs)
    )
  }

  /** The provider's last frame of this kind while no later output, mode switch or resize has outdated it. */
  protected readCurrentProviderVisibleState(
    ptyId: string,
    currentFrame = false
  ): RuntimeVisibleTerminalState | null {
    const cached = this.providerVisibleStateByPtyId.get(ptyId)
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    return cached?.state.generation === this.getPtyLifecycleGeneration(ptyId) &&
      cached.currentFrame === currentFrame &&
      this.getPtyOutputSequence(ptyId) <= cached.state.sequence &&
      (!trackedMode || trackedMode.isAlternateScreen === cached.state.isAlternateScreen) &&
      providerFrameFitsGrid(this.getTerminalSize(ptyId), undefined, cached.grid)
      ? cached.state
      : null
  }

  /**
   * One caller's gated primary wait. The retry gate is checked before joining shared work, and
   * only the default wait's expiry is a retry-policy result; a supplied deadline ends this caller.
   */
  private async awaitPrimaryVisibleFrame(
    ptyId: string,
    entry: ProviderVisibleRead,
    suppliedTimeoutMs?: number
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (this.providerVisibleRetryActive(ptyId)) {
      return null
    }
    // The read's current capture: after an actual null this is the pending fallback, joined, not re-asked.
    const capture = this.shareVisibleCapture(ptyId, entry, false)
    capture.primary ??= this.trackProviderVisibleWork(
      ptyId,
      entry,
      this.providerFrameStage(ptyId, entry, capture)
    )
    const result = await withTimeoutResult(
      capture.primary,
      suppliedTimeoutMs ?? VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
    )
    if (result.ok) {
      return result.value
    }
    if (
      suppliedTimeoutMs === undefined &&
      this.ownsProviderVisibleRead(ptyId, entry) &&
      !capture.settled &&
      !this.providerVisibleRetryActive(ptyId)
    ) {
      this.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
    }
    return null
  }

  private awaitVisibleFallback(
    ptyId: string,
    entry: ProviderVisibleRead,
    timeoutMs: number
  ): Promise<RuntimeTerminalProjection | null> {
    entry.fallback ??= this.trackProviderVisibleWork(ptyId, entry, this.fallbackStage(ptyId, entry))
    return timeoutMs > 0 ? withTimeout(entry.fallback, timeoutMs, null) : Promise.resolve(null)
  }

  private providerVisibleRetryActive(ptyId: string): boolean {
    return (this.providerVisibleRetryAtByPtyId.get(ptyId) ?? 0) > Date.now()
  }

  /** The shared primary provider frame: actual null opens the retry window; only an applicable frame clears it. */
  private async providerFrameStage(
    ptyId: string,
    entry: ProviderVisibleRead,
    capture: ProviderVisibleCapture
  ): Promise<RuntimeVisibleTerminalState | null> {
    const snapshot = await capture.raw
    if (!this.ownsProviderVisibleRead(ptyId, entry)) {
      return null
    }
    if (!snapshot) {
      this.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
      return null
    }
    if (
      this.providerSnapshotsWithLiveModeTransition.has(snapshot) &&
      !this.hasHostHistoryAuthority(ptyId)
    ) {
      // Why: the provider frame can predate a mode switch observed while its
      // RPC was pending; the ordered live emulator owns the post-switch grid.
      const liveState = await this.readHeadlessVisibleTerminalState(ptyId)
      if (!this.ownsProviderVisibleRead(ptyId, entry)) {
        return null
      }
      if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
        this.providerVisibleRetryAtByPtyId.delete(ptyId)
        this.publishProviderFrameMode(ptyId, snapshot)
        return liveState
      }
    }
    const state = await this.publishVisibleFrame(ptyId, entry, capture, snapshot)
    if (state) {
      this.providerVisibleRetryAtByPtyId.delete(ptyId)
    }
    return state
  }

  /**
   * The shared fallback: the primary's capture if still pending, then at most one more capture
   * after an actual null. It never retries a frame this stage itself captured.
   */
  private async fallbackStage(
    ptyId: string,
    entry: ProviderVisibleRead
  ): Promise<RuntimeTerminalProjection | null> {
    if (!this.ownsProviderVisibleRead(ptyId, entry)) {
      return null
    }
    const earlier = entry.capture
    let capture = this.shareVisibleCapture(ptyId, entry, true)
    let snapshot = await capture.raw
    if (!snapshot && capture === earlier && this.ownsProviderVisibleRead(ptyId, entry)) {
      capture = this.shareVisibleCapture(ptyId, entry, true)
      snapshot = await capture.raw
    }
    return snapshot && this.ownsProviderVisibleRead(ptyId, entry)
      ? this.publishVisibleFrame(ptyId, entry, capture, snapshot)
      : null
  }

  /**
   * The read's one capture: a pending or answered one is always joined, never duplicated. Only a
   * fallback after an actual null may take one more, so an entry issues or adopts at most two.
   */
  private shareVisibleCapture(
    ptyId: string,
    entry: ProviderVisibleRead,
    fallback: boolean
  ): ProviderVisibleCapture {
    const current = entry.capture
    if (current && (!current.answeredNull || !fallback || entry.attempts >= 2)) {
      return current
    }
    entry.attempts += 1
    const capture: ProviderVisibleCapture = {
      raw: this.acquireVisibleRaw(ptyId, entry),
      settled: false
    }
    void capture.raw.then((snapshot) => {
      capture.settled = true
      if (!snapshot) {
        capture.answeredNull = true
      }
    })
    entry.capture = capture
    this.trackProviderVisibleWork(ptyId, entry, capture.raw)
    return capture
  }

  /** Parses the capture once for every waiter, then publishes only while the read is still current. */
  private async publishVisibleFrame(
    ptyId: string,
    entry: ProviderVisibleRead,
    capture: ProviderVisibleCapture,
    snapshot: PtyProviderBufferSnapshot
  ): Promise<RuntimeVisibleTerminalState | null> {
    capture.parsed ??= this.trackProviderVisibleWork(
      ptyId,
      entry,
      this.parseVisibleSnapshot(snapshot)
    )
    const projection = await capture.parsed
    const frameGrid = { cols: snapshot.cols, rows: snapshot.rows }
    if (
      !this.ownsProviderVisibleRead(ptyId, entry) ||
      this.getPtyOutputSequence(ptyId) > snapshot.seq ||
      !providerFrameFitsGrid(this.getTerminalSize(ptyId), entry.grid, frameGrid)
    ) {
      return null
    }
    const state: RuntimeVisibleTerminalState = {
      ...projection,
      isAlternateScreen: snapshot.alternateScreen ?? false,
      sequence: snapshot.seq,
      generation: entry.generation
    }
    this.providerVisibleStateByPtyId.set(ptyId, {
      state,
      grid: frameGrid,
      currentFrame: entry.currentFrame
    })
    this.publishProviderFrameMode(ptyId, snapshot)
    return state
  }

  /** Only an applicable frame's screen mode becomes the mode later reads select their source by. */
  private publishProviderFrameMode(ptyId: string, snapshot: PtyProviderBufferSnapshot): void {
    if (typeof snapshot.alternateScreen !== 'boolean') {
      return
    }
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan(snapshot.alternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
    this.providerModeTrackersByPtyId.set(ptyId, tracker)
  }
}
