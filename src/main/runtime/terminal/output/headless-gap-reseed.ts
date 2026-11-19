import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './headless-terminal-state'
import type {
  GapRecovery,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import {
  gapJournalAfter,
  newGapRecovery,
  restartGapJournalAfterGap,
  startGapJournal,
  stopGapJournal
} from './gap-recovery-journal'
import {
  moveFreebuffTerminalStatus,
  resetFreebuffTerminalStatusAfterGap
} from './freebuff-terminal-status'
import {
  moveCodexNoticeTrackers,
  resetCodexNoticeTrackersAfterGap
} from './codex-notice-terminal-status'

const GAP_RESEED_MIN_INTERVAL_MS = 1_000
const GAP_RESEED_BACKOFF_MAX_MS = 30_000
const GAP_RESEED_WARN_AFTER_ATTEMPTS = 5
// One attempt's wait; a capture still running past it is cancelled before its slot frees.
const GAP_RESEED_CAPTURE_TIMEOUT_MS = 35_000
// Why: a storm gaps every hidden PTY at once; the daemon serializing them is the one already behind.
const GAP_RESEED_MAX_CONCURRENT_CAPTURES = 8
const GAP_RESEED_CATCH_UP_POLL_MS = 50

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.())

type RebuildResult = 'rebuilt' | 'failed' | 'behind'

/** After the provider drops output, main's model keeps parsing and answering queries, but its screen is untrusted
 *  until it is repainted from a provider snapshot plus the output journaled since that capture started. */
export abstract class OrcaRuntimeWithHeadlessGapReseed extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  private gapCapturesInFlight = 0
  // Keyed and insertion-ordered: FIFO admission, and a retired model leaves without a scan.
  private readonly gapCaptureWaiters = new Map<string, (granted: boolean) => void>()

  protected reseedHeadlessTerminalAfterDataGap(ptyId: string): void {
    if (this.ptysById.get(ptyId)?.connected === false) {
      // An exited PTY has no screen left to restore.
      this.disposeHeadlessTerminal(ptyId)
      return
    }
    if (!this.providerSequenceAnchorRevisions.has(ptyId)) {
      // No stamp places a provider snapshot in this stream: start over from the kept output, as before
      // recovery existed. The stream's first stamp starts recovery.
      this.gapRecoveryAwaitingStamp.add(ptyId)
      this.disposeHeadlessTerminal(ptyId)
      return
    }
    this.countGap(ptyId)
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const gapEnd = this.getPtyOutputSequence(ptyId)
    state.writeChain = state.writeChain
      .then(async () => {
        // CAN grounds the parser: the kept output can resume inside an escape whose start was dropped.
        await state.emulator.write('\x18')
        // Here, in stream order: chunks queued before the gap finished their carries already.
        resetFreebuffTerminalStatusAfterGap(
          state.emulator,
          this.terminalSpawnCommandsByPtyId.get(ptyId),
          this.ptysById.get(ptyId)?.launchAgent
        )
        resetCodexNoticeTrackersAfterGap(state.emulator)
        // The dropped bytes are behind this model now; a snapshot at the gap end needs nothing newer.
        state.outputSequence = Math.max(state.outputSequence, gapEnd)
      })
      .catch(() => {})
    if (state.gapReseed) {
      restartGapJournalAfterGap(state.gapReseed, gapEnd)
      return
    }
    this.startGapRecovery(ptyId, state)
  }

  /** Kept until the PTY exits: replacing the model must not erase a reader's evidence. */
  private countGap(ptyId: string): void {
    this.ptyGapCounts.set(ptyId, (this.ptyGapCounts.get(ptyId) ?? 0) + 1)
  }

  protected override onProviderSequenceAnchored(ptyId: string): void {
    if (
      this.gapRecoveryAwaitingStamp.delete(ptyId) &&
      this.ptysById.get(ptyId)?.connected !== false
    ) {
      const state = this.getOrCreateHeadlessTerminal(ptyId)
      if (!state.gapReseed) {
        this.countGap(ptyId)
        this.startGapRecovery(ptyId, state)
      }
    }
  }

  /** Execution-context correction mid-recovery waits for the rebuild: swapping the model then would strand its observers. */
  protected override replaceHeadlessTerminalAfterExecutionContextChange(
    ptyId: string,
    retryLateSeed = true
  ): void {
    const previous = this.headlessTerminals.get(ptyId)
    if (previous?.gapReseed) {
      previous.gapReseed.contextChangePending = true
      return
    }
    super.replaceHeadlessTerminalAfterExecutionContextChange(ptyId, retryLateSeed)
    const replacement = this.headlessTerminals.get(ptyId)
    // Same stream, new model: notices and session state observed so far still describe it.
    if (previous && replacement) {
      moveCodexNoticeTrackers(previous.emulator, replacement.emulator)
      moveFreebuffTerminalStatus(previous.emulator, replacement.emulator)
    }
  }

  private startGapRecovery(ptyId: string, state: RuntimeHeadlessTerminal): void {
    const recovery = newGapRecovery()
    state.gapReseed = recovery
    this.providerSnapshotPreferredPtys.add(ptyId)
    // Why: the hidden renderer missed the dropped bytes too, so it must not seed this model.
    this.headlessHydrationState.set(ptyId, 'pending')
    void this.runGapRecovery(ptyId, state, recovery)
  }

  private isGapRecovering(
    ptyId: string,
    state: RuntimeHeadlessTerminal,
    recovery: GapRecovery
  ): boolean {
    return (
      this.headlessTerminals.get(ptyId) === state &&
      state.gapReseed === recovery &&
      this.ptysById.get(ptyId)?.connected !== false
    )
  }

  private async runGapRecovery(
    ptyId: string,
    state: RuntimeHeadlessTerminal,
    recovery: GapRecovery
  ): Promise<void> {
    for (let attempt = 0; this.isGapRecovering(ptyId, state, recovery); attempt++) {
      if (attempt === GAP_RESEED_WARN_AFTER_ATTEMPTS) {
        console.warn('[terminal] dropped-output recovery still waiting for a current snapshot', {
          ptyIdSuffix: ptyId.slice(-10),
          attempts: attempt
        })
      }
      // Back off so a slow daemon or a sustained storm cannot loop captures; the screen stays untrusted meanwhile.
      const backoff =
        attempt < 2 ? 0 : Math.min(500 * 2 ** (attempt - 2), GAP_RESEED_BACKOFF_MAX_MS)
      const paced = (state.gapReseedLastCaptureAt ?? 0) + GAP_RESEED_MIN_INTERVAL_MS - Date.now()
      if (Math.max(backoff, paced) > 0) {
        await delay(Math.max(backoff, paced))
      }
      if (!this.isGapRecovering(ptyId, state, recovery)) {
        return
      }
      if (!(await this.acquireGapCaptureSlot(ptyId))) {
        return
      }
      try {
        if (
          this.isGapRecovering(ptyId, state, recovery) &&
          (await this.captureAndRebuildAfterGap(ptyId, state, recovery))
        ) {
          return
        }
      } catch {
        // A failed capture retries; the live model is untouched.
      } finally {
        stopGapJournal(recovery)
        this.releaseGapCaptureSlot()
      }
    }
  }

  private async captureAndRebuildAfterGap(
    ptyId: string,
    state: RuntimeHeadlessTerminal,
    recovery: GapRecovery
  ): Promise<boolean> {
    state.gapReseedLastCaptureAt = Date.now()
    // Journal before asking, so whatever the snapshot misses after its seq is here.
    startGapJournal(recovery, this.getPtyOutputSequence(ptyId))
    // The snapshot's seq is mapped through the offset as it lands; one that moves before the repaint cannot place it.
    const revision = this.providerSequenceAnchorRevisions.get(ptyId)
    // Screen only: a storm repeats this, and history readers go to the provider instead.
    const capture = new AbortController()
    const { snapshot, late } = await this.awaitProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: 0, signal: capture.signal },
      { timeoutMs: GAP_RESEED_CAPTURE_TIMEOUT_MS, fresh: true }
    )
    if (!snapshot) {
      // The slot bounds live captures, not attempts: cancel a timed-out one before giving the slot back.
      stopGapJournal(recovery)
      capture.abort()
      await late?.catch(() => {})
      return false
    }
    const deadline = Date.now() + GAP_RESEED_CAPTURE_TIMEOUT_MS
    for (;;) {
      const result = await this.rebuildScreenAfterGap(ptyId, state, recovery, snapshot, revision)
      if (result !== 'behind') {
        return result === 'rebuilt'
      }
      // The provider is ahead of the bytes this process has parsed; wait for them to land.
      if (Date.now() > deadline) {
        return false
      }
      await delay(GAP_RESEED_CATCH_UP_POLL_MS)
    }
  }

  /** Repaints in the write chain, between live chunks, so no chunk lands mid-repaint. */
  private rebuildScreenAfterGap(
    ptyId: string,
    state: RuntimeHeadlessTerminal,
    recovery: GapRecovery,
    snapshot: PtyProviderBufferSnapshot,
    anchorRevision: number | undefined
  ): Promise<RebuildResult> {
    const step = state.writeChain.then(async (): Promise<RebuildResult> => {
      if (!this.isGapRecovering(ptyId, state, recovery)) {
        return 'failed'
      }
      // An overflowed or invalidated journal, or a moved anchor, cannot rebuild however long output takes to catch up.
      if (
        recovery.journal === null ||
        this.providerSequenceAnchorRevisions.get(ptyId) !== anchorRevision
      ) {
        return 'failed'
      }
      const parsedTo = state.outputSequence
      const gaps = recovery.gaps
      // Older than the journal: it misses output this process already parsed.
      if (snapshot.seq < recovery.journalStart) {
        return 'failed'
      }
      if (parsedTo < snapshot.seq) {
        return 'behind'
      }
      // Null when a chunk straddling the snapshot's seq cannot be cut exactly.
      const after = gapJournalAfter(recovery, snapshot.seq, parsedTo)
      if (after === null) {
        return 'failed'
      }
      // Silent writes: the live parse already answered every query in these bytes.
      // CAN, then RIS: an open escape cannot swallow the reset.
      await state.emulator.write('\x18\x1bc')
      state.emulator.setRestoredOscLinks(undefined)
      // A renderer seed the gap overtook is no longer what this screen continues from.
      state.rendererSeedSeq = undefined
      state.rendererSeedEscapeTail = undefined
      if (!(await this.writeProviderSnapshotScreen(ptyId, state, snapshot))) {
        return 'failed'
      }
      // The reset cleared them; the replayed output can change them again.
      if (typeof snapshot.kittyKeyboardFlags === 'number') {
        await state.emulator.applyKittyKeyboardFlags(snapshot.kittyKeyboardFlags)
      }
      await state.emulator.write(`${snapshot.pendingEscapeTailAnsi ?? ''}${after}`)
      if (after === '') {
        // Live ownership saw every byte after the snapshot; with none, the provider's view is current.
        state.ownership.seedOwner(snapshot.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
      }
      // A gap during the repaint dropped bytes it never saw.
      if (!this.isGapRecovering(ptyId, state, recovery) || recovery.gaps !== gaps) {
        return 'failed'
      }
      this.finishGapRecovery(ptyId, state)
      return 'rebuilt'
    })
    state.writeChain = step.then(
      () => {},
      () => {}
    )
    return step
  }

  private finishGapRecovery(ptyId: string, state: RuntimeHeadlessTerminal): void {
    const contextChangePending = state.gapReseed?.contextChangePending === true
    state.gapReseed = undefined
    state.historyFromProvider = true
    this.headlessHydrationState.set(ptyId, 'done')
    this.providerSnapshotPreferredPtys.delete(ptyId)
    // No new text: observers confirm candidates that arrived while untrusted, with their own arrival times.
    this.observeHeadlessChunk(ptyId, state, '', Date.now())
    if (contextChangePending) {
      // After this chain step, so the replacement does not wait on the step that schedules it.
      setTimeout(() => {
        if (this.headlessTerminals.get(ptyId) === state) {
          this.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
        }
      }, 0).unref?.()
    }
  }

  /** A retired model's recovery leaves the capture line at once instead of holding it until a slot frees. */
  protected leaveGapCaptureLine(ptyId: string): void {
    const grant = this.gapCaptureWaiters.get(ptyId)
    if (grant) {
      this.gapCaptureWaiters.delete(ptyId)
      grant(false)
    }
  }

  private acquireGapCaptureSlot(ptyId: string): Promise<boolean> {
    if (this.gapCapturesInFlight < GAP_RESEED_MAX_CONCURRENT_CAPTURES) {
      this.gapCapturesInFlight++
      return Promise.resolve(true)
    }
    return new Promise((grant) => {
      // One recovery per model: a predecessor still waiting is already retired.
      this.gapCaptureWaiters.get(ptyId)?.(false)
      this.gapCaptureWaiters.set(ptyId, grant)
    })
  }

  private releaseGapCaptureSlot(): void {
    const next = this.gapCaptureWaiters.entries().next()
    if (!next.done) {
      this.gapCaptureWaiters.delete(next.value[0])
      next.value[1](true)
    } else {
      this.gapCapturesInFlight--
    }
  }
}
