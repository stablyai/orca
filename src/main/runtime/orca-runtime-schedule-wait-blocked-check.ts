// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithOnPtyData } from './orca-runtime-on-pty-data'
import {
  WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS,
  WAIT_BLOCKED_KEYWORD_CARRY_CHARS,
  WAIT_BLOCKED_KEYWORD_PATTERN
} from './orca-runtime-postlude'
import {
  appendWaitBlockedCarry,
  createWaitBlockedCheckState,
  readWaitBlockedCarry,
  resetWaitBlockedCarry,
  type WaitBlockedCheckState
} from './wait-blocked-check-state'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason
} from './terminal-wait-tail-state'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { createAgentStatusOscProcessor } from '../../shared/agent-status-osc'
import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'

export class OrcaRuntimeWithScheduleWaitBlockedCheck extends OrcaRuntimeWithOnPtyData {
  protected scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void {
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = createWaitBlockedCheckState()
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    // Why lowercase the joined window and not the chunk: the carry is already
    // lowercase, so this is one folded copy instead of a discarded per-chunk copy
    // plus the concatenation the pattern flattens anyway.
    const keywordWindow = `${state.keywordCarry}${appendedText}`.toLowerCase()
    const keywordHit = WAIT_BLOCKED_KEYWORD_PATTERN.test(keywordWindow)
    state.keywordCarry = keywordWindow.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
    appendWaitBlockedCarry(state.appended, appendedText)
    const elapsed = at - state.lastAt
    if (keywordHit || elapsed >= WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS || elapsed < 0) {
      this.runWaitBlockedCheck(ptyId, state, at)
      return
    }
    if (!state.timer) {
      // Why trailing edge: the final chunks of a burst must still be
      // evaluated or a prompt arriving right after a flood would go
      // unstamped until the next output.
      state.timer = setTimeout(() => {
        state.timer = null
        this.runWaitBlockedCheck(ptyId, state, Date.now())
      }, WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS - elapsed)
    }
  }

  protected runWaitBlockedCheck(ptyId: string, state: WaitBlockedCheckState, at: number): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      resetWaitBlockedCarry(state.appended)
      return
    }
    const nextWaitState = computeTerminalTailWaitState(
      pty.tailBuffer,
      pty.tailPartialLine,
      pty.preview
    )
    const previousWaitState = state.lastWaitState ?? {
      waitText: '',
      signal: null,
      fromTail: false
    }
    if (
      tailGainedNewerBlockedReason(
        previousWaitState,
        nextWaitState,
        readWaitBlockedCarry(state.appended)
      )
    ) {
      pty.waitBlockedAt = at
      this.recordAgentPromptPermissionObservation(ptyId)
    }
    state.lastAt = at
    state.lastWaitState = nextWaitState
    resetWaitBlockedCarry(state.appended)
  }

  // Why: the scanner's first run after a restore seed compares against a null
  // baseline, so a permission prompt visible only in seeded HISTORY would read
  // as newly gained and stamp waitBlockedAt "now" on the next benign chunk.
  // Store the seeded tail's wait state as the baseline WITHOUT stamping; only
  // a signal that appears in genuinely new output counts as gained.
  protected primeWaitBlockedBaselineFromSeededTail(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = createWaitBlockedCheckState()
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    if (state.lastWaitState === null) {
      state.lastWaitState = computeTerminalTailWaitState(
        pty.tailBuffer,
        pty.tailPartialLine,
        pty.preview
      )
    }
  }

  protected clearWaitBlockedCheckState(ptyId: string): void {
    const state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.waitBlockedCheckStateByPtyId.delete(ptyId)
  }

  protected processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    let processor = this.agentStatusOscProcessorsByPtyId.get(ptyId)
    if (!processor) {
      processor = createAgentStatusOscProcessor()
      this.agentStatusOscProcessorsByPtyId.set(ptyId, processor)
    }
    return processor(data)
  }

  /** Emit the facts batched while applying one chunk/frame as a single
   *  pty:sideEffect batch, preserving byte order. */
  protected flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void {
    if (entry.pendingFacts.length === 0) {
      return
    }
    const facts = entry.pendingFacts
    entry.pendingFacts = []
    this.emitTerminalSideEffectBatch(ptyId, facts)
  }

  /** Feed a main-fabricated OSC title/BEL frame (agent hook spinners) through
   *  the per-PTY tracker — NOT onPtyData, so emulator state, tails,
   *  transcripts, and stats never see synthetic bytes. Parsed via the
   *  tracker's stateless synthetic path: the shared chunk bell detector must
   *  never observe fabricated bytes, or a tick interleaved with a split real
   *  OSC corrupts its escape state (phantom/swallowed bells). While the
   *  side-effect kill switch is off the legacy pty:data copy still drives
   *  renderer parsers; this ingest keeps main's facts and records
   *  authoritative. */
  ingestSyntheticTitleFrame(ptyId: string, data: string): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.applyingChunk = true
    entry.chunkTouchedSessionTabs = false
    try {
      entry.tracker.applySyntheticTitleFrame(data)
    } finally {
      entry.applyingChunk = false
      this.flushPendingTerminalSideEffectFacts(ptyId, entry)
    }
    if (entry.chunkTouchedSessionTabs) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }

  /** Scan-authority handoff for a backgrounded PTY (daemon keep-tail
   *  thinning): while delegated, the daemon relays bell/133/pr-link/2031
   *  facts itself and the delivered bytes may be gapped — feeding them to
   *  main's transient scanners would mint phantom or duplicate facts. Title
   *  processing stays main-side either way. */
  setPtyTransientFactDelegation(
    ptyId: string,
    delegated: boolean,
    scanSeedAnsi?: string,
    mode2031PendingSubscribe?: true
  ): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.tracker.setTransientFactScanningSuppressed(delegated)
    if (!delegated && scanSeedAnsi) {
      // Prime the freshly reset scanner carry with the emulator's dangling
      // incomplete escape at the handoff position — a sequence split across
      // the un-background toggle must not mint a phantom bell or lose its
      // fact. titleScanData:'' keeps titles out (they were never suppressed).
      entry.tracker.handleChunk(scanSeedAnsi, {
        titleScanData: '',
        mode2031PendingSubscribe
      })
    }
  }
}
